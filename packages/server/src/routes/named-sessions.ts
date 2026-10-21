import type { SessionRunnerConfig } from '@workerdeck/core'
import {
  errorMessage,
  isSharing,
  type AgentConfig,
  type AgentConversationsResponse,
  type AgentInfo,
  type SessionAgentRequest,
  type SessionInfo,
  type Sharing,
  type UpdateAgentRequest,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import type { StoredAgent } from '../services/agent-store.ts'
import { SHARING_OFF, isAgentRefusal, type AgentRefusal, type RemoteJoin, type RetireOutcome } from '../services/agents.ts'
import type { AuthContext } from '../services/auth.ts'
import { requestedConfig, type SessionRecord } from '../services/session-records.ts'
import { entryInfo } from './conversations.ts'
import { vetCreateRequest } from './create-vet.ts'
import { sessionInfoOf } from './session-lookup.ts'

export type IdentityInput = {
  name?: unknown
  config?: AgentConfig
  lead?: unknown
  owner?: string
  sharing?: unknown
  crossOwner?: boolean
}

export type NamedSession = { agent: StoredAgent; session: SessionInfo }

const REQUESTED_KEYS = ['cwd', 'profile', 'model', 'reasoningEffort', 'permissionMode', 'allowDangerouslySkipPermissions', 'agentContextReset'] as const

// Record, then index row, then engine start: a team member never runs a turn unnamed (docs/PACKAGES.md, server).
export async function createNamedSession(
  ctx: ServerContext,
  identity: IdentityInput,
  request: Record<string, unknown>,
  auth: AuthContext,
): Promise<NamedSession> {
  const agents = ctx.agents
  const profile = typeof request.profile === 'string' ? request.profile : undefined
  const owner = settledOwner(ctx.owners.resolve(profile, identity.owner))
  const crossOwner = identity.crossOwner === true
  const draft = settled(
    agents.draft({
      name: identity.name,
      config: { ...configOfRequest(request), ...identity.config },
      lead: identity.lead,
      owner,
      sharing: sharingFor(ctx, profile, identity.sharing),
      crossOwner,
    }),
  )
  const vetted = vetCreateRequest(ctx, request, auth, owner)
  if (!vetted.ok) {
    fail(vetted.status, vetted.error)
  }
  const config = ctx.factory.buildRunnerConfig(vetted.request, { operator: ctx.auth.isOperator(auth), ...(owner === undefined ? {} : { owner }) })
  const remoteLead = remoteLeadOf(ctx, identity.lead)
  let agent: StoredAgent | undefined
  try {
    const runner = await ctx.factory.createRunner(config, {
      id: draft.id,
      brief: draft.config.brief?.trim() || undefined,
      instructionScope: draft.config.instructionScope,
      agent: true,
      beforeStart: async (built) => {
        agent = await writeIdentity(ctx, draft, built.info(), remoteLead, crossOwner)
      },
    })
    return { agent: agents.get(runner.id) ?? agent!, session: runner.info() }
  } catch (error) {
    if (!agent) {
      await ctx.records.discard(draft.id)
    }
    throw error
  }
}

// POST /agents: the identity and its settings in one body; the settings become the session's create request.
export function requestFromConfig(config: AgentConfig, prompt: string | undefined): Record<string, unknown> {
  return stripUndefined({
    cwd: config.cwd,
    profile: config.profile,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions' ? true : undefined,
    agentContextReset: config.agentContextReset ?? true,
    prompt,
  })
}

export function identityOf(agent: SessionAgentRequest): IdentityInput {
  return {
    name: agent.name,
    config: stripUndefined({ brief: agent.brief, instructionScope: agent.instructionScope, sleepAfterMs: agent.sleepAfterMs }),
    lead: agent.lead,
    ...(agent.owner === undefined ? {} : { owner: agent.owner }),
    sharing: agent.sharing,
    crossOwner: agent.crossOwner === true,
  }
}

// The caller holds the session's lifecycle lock.
export async function nameSession(ctx: ServerContext, info: SessionInfo, input: SessionAgentRequest): Promise<StoredAgent> {
  const agents = ctx.agents
  const named = agents.get(info.id)
  if (named) {
    const { brief, instructionScope, sleepAfterMs, ...identity } = input
    const config = stripUndefined({ brief, instructionScope, sleepAfterMs })
    return settled(await updateAgentLocked(ctx, named.id, { ...identity, ...(Object.keys(config).length > 0 ? { config } : {}) }))
  }
  const record = await ctx.records.get(info.id)
  if (!record || record.closedAt !== undefined) {
    fail(404, 'session not found')
  }
  const owner = input.owner === undefined && info.owner !== undefined ? info.owner : settledOwner(ctx.owners.resolve(info.profile, input.owner))
  const identity = identityOf(input)
  const name = input.name ?? (typeof info.title === 'string' && info.title.trim() !== '' ? agents.freeName(info.title.trim()) : undefined)
  const draft = settled(
    agents.draft({
      ...identity,
      id: info.id,
      name,
      config: { ...configOfInfo(info), ...identity.config },
      owner,
      sharing: sharingFor(ctx, info.profile, input.sharing),
    }),
  )
  if (draft.owner !== record.owner) {
    await writeRecordAuthority(ctx, info.id, undefined, draft.owner)
  }
  const agent = await writeIdentity(ctx, draft, info, remoteLeadOf(ctx, input.lead), input.crossOwner === true)
  ctx.teams?.republish()
  return agent
}

// Un-naming: refused in a team; the record keeps its owner, scope, history and conversation.
export async function unnameSession(ctx: ServerContext, id: string): Promise<void> {
  const gone = settled(await ctx.agents.unname(id))
  ctx.teams?.retiring(gone)
  ctx.teams?.republish()
}

// Every leaving session is gated and fenced first, then the tombstones land, then each record closes. A close that
// fails keeps its session gated and fenced (no work, no wake) for the retry or the startup pass to finish.
export function retireAgent(ctx: ServerContext, id: string, members: 'release' | 'retire', guard?: () => Promise<void>): Promise<RetireOutcome> {
  const crew = ctx.agents.members(id).map((member) => member.id)
  return ctx.locks.run([id, ...crew], async () => {
    const agent = ctx.agents.get(id)
    if (!agent) {
      fail(404, 'agent not found')
    }
    if (ctx.agents.members(id).some((member) => !crew.includes(member.id))) {
      fail(409, `${agent.name}'s team changed; try again`)
    }
    await guard?.()
    const leaving = members === 'retire' ? [id, ...crew.filter((member) => !ctx.agents.frozen(member))] : [id]
    for (const gone of leaving) {
      await hold(ctx, gone)
    }
    let outcome: RetireOutcome | AgentRefusal
    try {
      outcome = await ctx.agents.retire(id, members)
    } catch (error) {
      leaving.forEach((gone) => release(ctx, gone))
      throw error
    }
    if (isAgentRefusal(outcome)) {
      leaving.forEach((gone) => release(ctx, gone))
      fail(outcome.status, outcome.error)
    }
    const retired = new Set(outcome.retired.map((gone) => gone.id))
    leaving.filter((gone) => !retired.has(gone)).forEach((gone) => release(ctx, gone))
    for (const gone of outcome.retired) {
      ctx.teams?.retiring(gone)
    }
    const failures: unknown[] = []
    for (const gone of outcome.retired) {
      await finishRetired(ctx, gone.id).catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) {
      fail(500, `retired, but closing did not finish (${errorMessage(failures[0])}); delete it again to finish`)
    }
    return outcome
  })
}

// Idempotent: closes a tombstoned session's record and removes its runner. The caller holds its lifecycle lock.
export async function finishRetired(ctx: ServerContext, id: string): Promise<void> {
  await hold(ctx, id)
  const record = await ctx.records.get(id)
  if (record && record.closedAt === undefined) {
    await ctx.cuts.closeLocked(id, { holdOnFailure: true })
  }
  await endSession(ctx, id)
  release(ctx, id)
}

async function hold(ctx: ServerContext, id: string): Promise<void> {
  ctx.locks.hold(id)
  await ctx.parking.fence(id)
}

function release(ctx: ServerContext, id: string): void {
  ctx.locks.release(id)
  ctx.parking.unfence(id)
}

// A real close (loud: `session_closed` goes out). The caller holds the session's lifecycle lock.
export async function endSession(ctx: ServerContext, id: string): Promise<void> {
  await ctx.cuts.closeLocked(id)
  ctx.registry.remove(id)
  ctx.bridge.remove(id)
  await ctx.parking.discard(id)
  ctx.attachmentStore.drop(id)
  ctx.producedFiles.drop(id)
}

export async function reconcileIdentity(ctx: ServerContext, onError: (error: unknown) => void, dropOrphans: boolean): Promise<void> {
  for (const tombstone of ctx.agents.tombstones()) {
    const record = await ctx.records.get(tombstone.id).catch((error: unknown) => {
      onError(error)
      return null
    })
    if (!record || record.closedAt !== undefined) {
      continue
    }
    try {
      await ctx.locks.run([tombstone.id], () => finishRetired(ctx, tombstone.id))
    } catch (error) {
      onError(error)
    }
  }
  const orphans: StoredAgent[] = []
  for (const agent of ctx.agents.indexed()) {
    try {
      const record = await ctx.records.get(agent.id)
      if (record) {
        await syncSettingsCache(ctx, agent.id)
      } else {
        orphans.push(agent)
      }
    } catch (error) {
      onError(error)
    }
  }
  if (!dropOrphans) {
    return
  }
  if (orphans.length === 0) {
    return
  }
  await ctx.agents.drop(orphans.map((agent) => agent.id))
  for (const agent of orphans) {
    onError(new Error(`agent ${agent.name} (${agent.id}) has no session record; dropped from the index`))
  }
}

// The rest of the patch lands first, so a bad name or config never leaves a join the lead accepted and this side dropped.
export function updateAgent(
  ctx: ServerContext,
  agent: StoredAgent,
  patch: UpdateAgentRequest,
  auth?: AuthContext,
): Promise<StoredAgent | AgentRefusal> {
  return ctx.locks.run([agent.id], () => updateAgentLocked(ctx, agent.id, patch, auth))
}

// The whole patch is validated before anything is written; the record (settings, owner) is written first, then the
// index. An index write that still refuses leaves the record as the authority and the cache reconciled from it.
async function updateAgentLocked(ctx: ServerContext, id: string, patch: UpdateAgentRequest, auth?: AuthContext): Promise<StoredAgent | AgentRefusal> {
  await syncSettingsCache(ctx, id)
  const current = ctx.agents.get(id)
  if (!current) {
    return { status: 404, error: `no such agent: ${id}` }
  }
  if (patch.owner !== undefined) {
    const owner = ctx.owners.resolve(undefined, patch.owner)
    if (isAgentRefusal(owner)) {
      return owner
    }
  }
  const remoteLead = remoteLeadOf(ctx, patch.lead)
  const { lead: _lead, ...local } = patch
  const refused = ctx.agents.previewUpdate(id, remoteLead === undefined ? patch : local)
  if (refused) {
    return refused
  }
  const owner = patch.owner !== undefined && patch.owner !== current.owner ? patch.owner : undefined
  let requested: SessionRunnerConfig | undefined
  if (patch.config !== undefined && auth && REQUESTED_KEYS.some((key) => key in patch.config!)) {
    const record = await ctx.records.get(id)
    const canonical = record?.requested ?? record?.running
    const merged: Record<string, unknown> = { ...(canonical ? settingsFrom(current.config, canonical) : current.config), ...patch.config }
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) {
        delete merged[key]
      }
    }
    const principalOwner = owner ?? current.owner
    const vetted = vetCreateRequest(ctx, requestFromConfig(merged as AgentConfig, undefined), auth, principalOwner)
    if (!vetted.ok) {
      return { status: vetted.status, error: vetted.error }
    }
    requested = requestedConfig(
      ctx.factory.buildRunnerConfig(vetted.request, { operator: ctx.auth.isOperator(auth), ...(principalOwner ? { owner: principalOwner } : {}) }),
    )
  }
  await writeRecordAuthority(ctx, id, requested, owner)
  let outcome: StoredAgent | AgentRefusal
  try {
    outcome = await patchAgent(ctx, current, patch)
  } catch (error) {
    await syncSettingsCache(ctx, id).catch(() => {})
    throw error
  }
  if (isAgentRefusal(outcome)) {
    await syncSettingsCache(ctx, id)
  } else if (patch.sharing !== undefined) {
    ctx.teams?.republish()
  }
  return outcome
}

// The record's own fields: `requested` (what the next conversation starts from) and `owner`, the runtime's copy and the
// live runner's with it.
async function writeRecordAuthority(ctx: ServerContext, id: string, settings: SessionRunnerConfig | undefined, owner: string | undefined): Promise<void> {
  if (settings === undefined && owner === undefined) {
    return
  }
  const record = await ctx.records.get(id)
  if (!record || record.closedAt !== undefined) {
    return
  }
  await ctx.records.transactDurable(id, (latest) => {
    const next: SessionRecord = { ...latest! }
    if (settings) {
      next.requested = withSettings(latest!.requested ?? latest!.running, settings)
    }
    if (owner !== undefined) {
      next.owner = owner
      for (const key of ['requested', 'running'] as const) {
        if (next[key]) {
          next[key] = { ...next[key], owner }
        }
      }
      if (latest!.runtime) {
        next.runtime = { ...latest!.runtime, info: { ...latest!.runtime.info, owner }, config: { ...latest!.runtime.config, owner } }
      }
    }
    return next
  })
  if (owner !== undefined) {
    ctx.registry.get(id)?.setOwner?.(owner)
    const live = ctx.parking.configOf(id)
    if (live) {
      ctx.parking.remember(id, { ...live, owner })
    }
  }
}

// The index keeps a copy of the record's engine settings for readers that cannot wait on a record; this brings it back
// in line after a partial failure and at startup.
export async function syncSettingsCache(ctx: ServerContext, id: string): Promise<void> {
  const record = await ctx.records.get(id)
  const requested = record?.requested ?? record?.running
  if (!requested || !ctx.agents.get(id) || ctx.agents.frozen(id)) {
    return
  }
  await ctx.agents.patch(id, (agent) => {
    const config = settingsFrom(agent.config, requested)
    const owner = record?.owner ?? agent.owner
    return config === agent.config && owner === agent.owner ? agent : { ...agent, config, ...(owner === undefined ? {} : { owner }) }
  })
}

const SETTING_KEYS = ['cwd', 'profile', 'model', 'reasoningEffort', 'permissionMode'] as const

// Set and cleared from `requested`: the record is the authority for the engine settings an agent shows.
function settingsFrom(config: AgentConfig, requested: SessionRunnerConfig): AgentConfig {
  const next: Record<string, unknown> = { ...config }
  let changed = false
  for (const key of SETTING_KEYS) {
    const value = (requested as Record<string, unknown>)[key]
    const wanted = typeof value === 'string' ? value : undefined
    if (next[key] !== wanted) {
      changed = true
      if (wanted === undefined) {
        delete next[key]
      } else {
        next[key] = wanted
      }
    }
  }
  return changed ? (next as AgentConfig) : config
}

function withSettings(base: SessionRunnerConfig | undefined, settings: SessionRunnerConfig): SessionRunnerConfig {
  const next: Record<string, unknown> = { ...base }
  for (const key of REQUESTED_KEYS) {
    const value = (settings as Record<string, unknown>)[key]
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  return next as SessionRunnerConfig
}

async function patchAgent(ctx: ServerContext, agent: StoredAgent, patch: UpdateAgentRequest): Promise<StoredAgent | AgentRefusal> {
  const remoteLead = remoteLeadOf(ctx, patch.lead)
  if (remoteLead === undefined) {
    return ctx.agents.update(agent.id, patch, {
      onLeadChanged: (previous) => ctx.teams?.left(agent.id, previous.lead, previous.remoteLead?.op),
      onJoinCancelled: (lead, op) => ctx.teams?.left(agent.id, lead, op),
    })
  }
  const { lead: _lead, ...rest } = patch
  const updated = await ctx.agents.update(agent.id, rest)
  if (isAgentRefusal(updated) || updated.lead === remoteLead) {
    return updated
  }
  return joinRemote(ctx, updated, remoteLead, (joined) => ctx.agents.update(agent.id, { lead: remoteLead }, { joined }))
}

export function agentInfoOf(ctx: ServerContext, agent: StoredAgent, record: SessionRecord | null): AgentInfo {
  const info = ctx.agents.public(agent)
  const requested = record?.requested ?? record?.running
  return {
    ...info,
    config: requested ? settingsFrom(info.config, requested) : info.config,
    ...(record?.startFailed ? { startFailed: record.startFailed.error } : {}),
    ...(record?.pendingPrompt?.state === 'uncertain' ? { undelivered: record.pendingPrompt.text } : {}),
  }
}

// Each past row is checked against its own frozen auth.
export async function conversationRows(ctx: ServerContext, id: string, auth: AuthContext, live: boolean): Promise<AgentConversationsResponse> {
  const record = await ctx.records.get(id)
  const rows: AgentConversationsResponse['conversations'] = []
  const current = live && record?.closedAt === undefined ? await sessionInfoOf(ctx, id) : undefined
  if (current && ctx.auth.canSee(auth, current)) {
    rows.push({
      sessionId: id,
      current: true,
      startedAt: record?.conversations.at(-1)?.endedAt ?? record?.createdAt ?? current.createdAt,
      ...(current.title ? { title: current.title } : {}),
      session: ctx.projects.withProject(current),
    })
  }
  const history = record?.conversations ?? []
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]!
    if (!ctx.auth.canSee(auth, entryInfo(id, entry))) {
      continue
    }
    rows.push({
      sessionId: id,
      current: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.transcript ? { transcript: entry.transcript } : {}),
    })
  }
  return { conversations: rows }
}

async function writeIdentity(
  ctx: ServerContext,
  draft: StoredAgent,
  info: SessionInfo,
  remoteLead: string | undefined,
  crossOwner: boolean,
): Promise<StoredAgent> {
  const recipe = await rollAvatar(ctx, draft, info)
  const stamped = recipe === undefined ? draft : { ...draft, avatarRecipe: recipe }
  return settled(
    remoteLead
      ? await joinRemote(ctx, stamped, remoteLead, (joined) => ctx.agents.create(stamped, joined))
      : await ctx.agents.create(stamped, undefined, crossOwner),
  )
}

export function remoteLeadOf(ctx: ServerContext, lead: unknown): string | undefined {
  if (typeof lead !== 'string') {
    return undefined
  }
  const id = ctx.agents.localId(lead)
  return ctx.agents.remoteGateway(id) ? id : undefined
}

function joinRemote(
  ctx: ServerContext,
  mover: StoredAgent,
  lead: string,
  commit: (joined: RemoteJoin) => Promise<StoredAgent | AgentRefusal>,
): Promise<StoredAgent | AgentRefusal> {
  if (!ctx.teams) {
    return Promise.resolve({ status: 409, error: 'this gateway is not connected to a relay' })
  }
  return ctx.teams.join(mover, lead, commit)
}

function settledOwner(outcome: { owner: string | undefined } | AgentRefusal): string | undefined {
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  return outcome.owner
}

// Materialized at create: the request, then the profile's default, then the gateway's. Later default changes never
// move an agent. A default of shared on a gateway that shares nothing lands as private; a request for it is refused.
function sharingFor(ctx: ServerContext, profile: string | undefined, requested: unknown): Sharing {
  const allowed = ctx.options.agentSharing?.allowShared !== false
  if (requested !== undefined) {
    if (!isSharing(requested)) {
      fail(400, "sharing must be 'private' or 'shared'")
    }
    if (requested === 'shared' && !allowed) {
      fail(409, SHARING_OFF)
    }
    return requested
  }
  const fallback = (profile === undefined ? undefined : ctx.profiles.get(profile)?.defaults?.sharing) ?? ctx.options.agentSharing?.default
  return fallback === 'shared' && allowed ? 'shared' : 'private'
}

export function settled<T extends object>(outcome: T | AgentRefusal): T {
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  return outcome
}

export async function rollAvatar(ctx: ServerContext, agent: StoredAgent, session: SessionInfo | undefined): Promise<unknown> {
  if (!ctx.avatars) {
    return undefined
  }
  const project = session ? (ctx.projects.withProject(session).project?.root ?? session.cwd) : undefined
  try {
    return await ctx.avatars.roll(agent.avatarSeed, session?.engine, project || undefined)
  } catch {
    return undefined
  }
}

function configOfRequest(request: Record<string, unknown>): AgentConfig {
  const pick = (key: string): string | undefined => (typeof request[key] === 'string' ? (request[key] as string) : undefined)
  return stripUndefined({
    cwd: pick('cwd'),
    profile: pick('profile'),
    model: pick('model'),
    reasoningEffort: pick('reasoningEffort'),
    permissionMode: pick('permissionMode') as AgentConfig['permissionMode'],
  })
}

function configOfInfo(info: SessionInfo): AgentConfig {
  return stripUndefined({
    cwd: info.cwd || undefined,
    profile: info.profile,
    model: info.model,
    reasoningEffort: info.effort ?? undefined,
    permissionMode: info.permissionMode,
  })
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
