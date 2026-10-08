import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AVATAR_SEED_MAX } from '@workerdeck/core'
import {
  isOwnerName,
  isSharing,
  type AgentConfig,
  type AgentResponse,
  type CreateAgentRequest,
  type InviteRemoteMemberRequest,
  type RetireAgentRequest,
  type SessionInfo,
  type Sharing,
  type UpdateAgentRequest,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import { SHARING_OFF, isAgentRefusal, type AgentRefusal, type AgentService, type RemoteJoin } from '../services/agents.ts'
import type { StoredAgent } from '../services/agent-store.ts'
import type { AvatarImage } from '../services/avatars.ts'
import { vetCreateRequest } from './create-vet.ts'
import { sessionInfoOf } from './session-lookup.ts'

export async function handleAgents(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> {
  const agents = ctx.agents
  const rest = pathname.slice((ctx.basePath + '/agents').length).replace(/^\//, '')
  if (rest === '') {
    requireMethod(req, 'GET', 'POST')
    if (req.method === 'GET') {
      json(res, 200, { agents: agents.list() })
      return
    }
    await createAgent(ctx, agents, req, res, auth)
    return
  }
  const [id, action, ...extra] = rest.split('/').map(decodeURIComponent)
  const agent = id === undefined ? undefined : agents.get(id)
  if (!agent || extra.length > (action === 'remote-members' ? 1 : 0)) {
    fail(404, 'agent not found')
  }
  if (action === 'remote-members') {
    await remoteMembers(ctx, req, res, agent, extra[0])
    return
  }
  if (action === 'restart') {
    requireMethod(req, 'POST')
    const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as { prompt?: unknown }
    const previous = agent.sessionId === undefined ? undefined : ctx.registry.get(agent.sessionId)
    const created = await startSession(ctx, agent, typeof body.prompt === 'string' ? body.prompt : undefined, auth)
    const status = previous?.info().status
    if (previous && status !== 'closed' && status !== 'failed') {
      previous.close('server')
    }
    const bound = await bindWithAvatar(ctx, agent, created)
    if (isAgentRefusal(bound)) {
      ctx.registry.get(created.id)?.close('server')
      fail(bound.status, bound.error)
    }
    await respond(ctx, res, 200, bound, created)
    return
  }
  if (action === 'avatar') {
    requireMethod(req, 'POST')
    const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as { seed?: unknown }
    const changed = await rerollAvatar(ctx, agent, readSeed(body.seed))
    if (isAgentRefusal(changed)) {
      fail(changed.status, changed.error)
    }
    await respond(ctx, res, 200, changed)
    return
  }
  if (action === 'avatar-preview.png') {
    requireMethod(req, 'GET')
    const seed = readSeed(new URL(req.url ?? '', 'http://x').searchParams.get('seed') ?? undefined)
    if (seed === undefined) {
      fail(400, 'seed is required')
    }
    const recipe = await rollFor(ctx, agent, seed)
    await sendImage(req, res, await ctx.avatars!.still(recipe))
    return
  }
  if (action === 'avatar.png' || action === 'avatar-busy.png') {
    requireMethod(req, 'GET')
    await sendAvatar(ctx, req, res, agent, action === 'avatar-busy.png')
    return
  }
  if (action !== undefined) {
    fail(404, 'agent not found')
  }
  requireMethod(req, 'GET', 'PATCH', 'DELETE')
  if (req.method === 'GET') {
    await respond(ctx, res, 200, agent)
    return
  }
  if (req.method === 'PATCH') {
    const patch = (await readJsonBody(req, ctx.maxBodyBytes)) as UpdateAgentRequest
    const updated = await updateAgent(ctx, agent, isRecord(patch) ? patch : {})
    if (isAgentRefusal(updated)) {
      fail(updated.status, updated.error)
    }
    await respond(ctx, res, 200, updated)
    return
  }
  const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as RetireAgentRequest
  const members = body.members === 'retire' ? 'retire' : 'release'
  const outcome = await agents.retire(agent.id, members)
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  for (const gone of outcome.retired) {
    ctx.teams?.retiring(gone)
  }
  for (const gone of outcome.retired) {
    const runner = gone.sessionId === undefined ? undefined : ctx.registry.get(gone.sessionId)
    const status = runner?.info().status
    if (runner && status !== 'closed' && status !== 'failed') {
      runner.close('client')
    }
  }
  json(res, 200, { retired: outcome.retired.map((a) => a.id), released: outcome.released.map((a) => a.id) })
}

async function createAgent(ctx: ServerContext, agents: AgentService, req: IncomingMessage, res: ServerResponse, auth: AuthContext) {
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateAgentRequest
  if (!isRecord(body)) {
    fail(400, 'request body must be a JSON object')
  }
  if (body.adopt !== undefined) {
    await adoptSession(ctx, agents, res, body)
    return
  }
  const profile = isRecord(body.config) ? stringOr(body.config.profile) : undefined
  const owner = settledOwner(ctx.owners.resolve(profile, body.owner))
  const crossOwner = body.crossOwner === true
  const draft = agents.draft({ ...body, owner, sharing: sharingFor(ctx, profile, body.sharing), crossOwner })
  if (isAgentRefusal(draft)) {
    fail(draft.status, draft.error)
  }
  const remoteLead = remoteLeadOf(ctx, body.lead)
  // Stored before the session starts so the lead's reconcile finds the member half; undone if the start fails.
  const agent = settled(
    remoteLead
      ? await joinRemote(ctx, draft, remoteLead, (joined) => agents.create(draft, joined))
      : await agents.create(draft, undefined, crossOwner),
  )
  let created: SessionInfo
  try {
    created = await startSession(ctx, agent, typeof body.prompt === 'string' ? body.prompt : undefined, auth)
  } catch (error) {
    const undone = await agents.retire(agent.id, 'release')
    if (!isAgentRefusal(undone)) {
      undone.retired.forEach((gone) => ctx.teams?.retiring(gone))
    }
    throw error
  }
  const bound = await bindWithAvatar(ctx, agent, created)
  if (isAgentRefusal(bound)) {
    ctx.registry.get(created.id)?.close('server')
    fail(bound.status, bound.error)
  }
  await respond(ctx, res, 201, bound, created)
}

function remoteLeadOf(ctx: ServerContext, lead: unknown): string | undefined {
  if (typeof lead !== 'string') {
    return undefined
  }
  const id = ctx.agents.localId(lead)
  return ctx.agents.remoteGateway(id) ? id : undefined
}

async function joinRemote(
  ctx: ServerContext,
  mover: StoredAgent,
  lead: string,
  commit: (joined: RemoteJoin) => Promise<StoredAgent | AgentRefusal>,
): Promise<StoredAgent | AgentRefusal> {
  if (!ctx.teams) {
    return { status: 409, error: 'this gateway is not connected to a relay' }
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

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function settled(outcome: StoredAgent | AgentRefusal): StoredAgent {
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  return outcome
}

// The rest of the patch lands first, so a bad name or config never leaves a join the lead accepted and this side dropped.
async function updateAgent(ctx: ServerContext, agent: StoredAgent, patch: UpdateAgentRequest): Promise<StoredAgent | AgentRefusal> {
  if (patch.owner !== undefined) {
    const owner = ctx.owners.resolve(undefined, patch.owner)
    if (isAgentRefusal(owner)) {
      return owner
    }
  }
  const outcome = await patchAgent(ctx, agent, patch)
  if (patch.sharing !== undefined && !isAgentRefusal(outcome)) {
    ctx.teams?.republish()
  }
  return outcome
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

async function remoteMembers(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, lead: StoredAgent, member?: string) {
  const teams = ctx.teams
  if (!teams) {
    fail(409, 'this gateway is not connected to a relay')
  }
  let outcome: StoredAgent | AgentRefusal
  if (member === undefined) {
    requireMethod(req, 'POST')
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as InviteRemoteMemberRequest
    if (!isRecord(body) || typeof body.agent !== 'string') {
      fail(400, 'agent must be an agent id on another gateway (gateway:agentId)')
    }
    if (body.owner !== undefined && !isOwnerName(body.owner)) {
      fail(400, 'owner must be 1 to 32 lowercase letters, digits or dashes')
    }
    outcome = await teams.invite(lead, body.agent, body.owner)
  } else {
    requireMethod(req, 'DELETE')
    const invite = new URL(req.url ?? '', 'http://x').searchParams.get('invite') ?? undefined
    outcome = await teams.removeMember(lead, member, invite)
  }
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  await respond(ctx, res, 200, outcome)
}

async function adoptSession(ctx: ServerContext, agents: AgentService, res: ServerResponse, body: CreateAgentRequest) {
  if (typeof body.adopt !== 'string') {
    fail(400, 'adopt must be a session id')
  }
  const info = await sessionInfoOf(ctx, body.adopt)
  if (!info) {
    fail(404, 'session not found')
  }
  if (agents.bySession(info.id)) {
    fail(409, 'that session already belongs to an agent')
  }
  const config = { ...configOf(info), ...body.config }
  const owner =
    body.owner === undefined && info.owner !== undefined ? info.owner : settledOwner(ctx.owners.resolve(config.profile, body.owner))
  const crossOwner = body.crossOwner === true
  const sharing = sharingFor(ctx, config.profile, body.sharing)
  const name = body.name ?? (typeof info.title === 'string' && info.title.trim() !== '' ? agents.freeName(info.title.trim()) : undefined)
  const draft = agents.draft({ name, config, lead: body.lead, owner, sharing, crossOwner })
  if (isAgentRefusal(draft)) {
    fail(draft.status, draft.error)
  }
  const recipe = await rollAvatar(ctx, draft, info)
  const bound: StoredAgent = { ...draft, sessionId: info.id, ...(recipe === undefined ? {} : { avatarRecipe: recipe }) }
  const remoteLead = remoteLeadOf(ctx, body.lead)
  const adopted = settled(
    remoteLead
      ? await joinRemote(ctx, bound, remoteLead, (joined) => agents.create(bound, joined))
      : await agents.create(bound, undefined, crossOwner),
  )
  await respond(ctx, res, 201, adopted)
}

function readSeed(seed: unknown): string | undefined {
  if (seed === undefined || seed === null || seed === '') {
    return undefined
  }
  if (typeof seed !== 'string' || seed.trim().length === 0 || seed.length > AVATAR_SEED_MAX) {
    fail(400, `seed must be a string of at most ${AVATAR_SEED_MAX} characters`)
  }
  return seed.trim()
}

async function rollFor(ctx: ServerContext, agent: StoredAgent, seed: string): Promise<unknown> {
  if (!ctx.avatars) {
    fail(404, 'this gateway draws no avatars')
  }
  const session = agent.sessionId === undefined ? undefined : await sessionInfoOf(ctx, agent.sessionId)
  const recipe = await rollAvatar(ctx, { ...agent, avatarSeed: seed }, session)
  if (recipe === undefined) {
    fail(503, 'the avatar pack could not be loaded')
  }
  return recipe
}

// A new seed (random unless given) rolls and saves a new avatar; the agent's `avatar` address changes with it.
export async function rerollAvatar(ctx: ServerContext, agent: StoredAgent, seed?: string): Promise<StoredAgent | AgentRefusal> {
  const next = seed ?? randomUUID()
  const recipe = await rollFor(ctx, agent, next)
  return ctx.agents.patch(agent.id, (current) => ({ ...current, avatarSeed: next, avatarRecipe: recipe }))
}

async function bindWithAvatar(ctx: ServerContext, agent: StoredAgent, session: SessionInfo): Promise<StoredAgent | AgentRefusal> {
  const recipe = (ctx.agents.get(agent.id) ?? agent).avatarRecipe ?? (await rollAvatar(ctx, agent, session))
  return ctx.agents.bind(agent.id, session.id, recipe)
}

async function rollAvatar(ctx: ServerContext, agent: StoredAgent, session: SessionInfo | undefined): Promise<unknown> {
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

async function sendAvatar(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, agent: StoredAgent, busy: boolean): Promise<void> {
  const avatars = ctx.avatars
  if (!avatars) {
    fail(404, 'this gateway draws no avatars')
  }
  let recipe = agent.avatarRecipe
  if (recipe === undefined) {
    const session = agent.sessionId === undefined ? undefined : await sessionInfoOf(ctx, agent.sessionId)
    const rolled = await rollAvatar(ctx, agent, session)
    if (rolled === undefined) {
      fail(503, 'the avatar pack could not be loaded')
    }
    const stored = settled(
      await ctx.agents.patch(agent.id, (current) => (current.avatarRecipe === undefined ? { ...current, avatarRecipe: rolled } : current)),
    )
    recipe = stored.avatarRecipe
  }
  const image = busy ? await avatars.busy(recipe) : await avatars.still(recipe)
  if (!image) {
    fail(404, 'this avatar pack has no busy animation')
  }
  await sendImage(req, res, image)
}

// Revalidated rather than cached for a day: the address is stable per agent while the avatar can change.
async function sendImage(req: IncomingMessage, res: ServerResponse, image: AvatarImage): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'image/png', etag: image.etag, 'cache-control': 'private, no-cache' }
  if (image.durations) {
    headers['x-frame-durations'] = image.durations.join(',')
  }
  if (req.headers['if-none-match'] === image.etag) {
    res.writeHead(304, headers).end()
    return
  }
  res.writeHead(200, headers).end(Buffer.from(image.png))
}

async function startSession(ctx: ServerContext, agent: StoredAgent, prompt: string | undefined, auth: AuthContext): Promise<SessionInfo> {
  const { config } = agent
  const request = {
    cwd: config.cwd,
    profile: config.profile,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions' ? true : undefined,
    agentContextReset: config.agentContextReset ?? true,
    prompt,
  }
  const vetted = vetCreateRequest(ctx, stripUndefined(request), auth, agent.owner)
  if (!vetted.ok) {
    fail(vetted.status, vetted.error)
  }
  const principal = { operator: ctx.auth.isOperator(auth), ...(agent.owner === undefined ? {} : { owner: agent.owner }) }
  const runner = await ctx.factory.createRunner(ctx.factory.buildRunnerConfig(vetted.request, principal), {
    brief: config.brief?.trim() || undefined,
    agent: true,
  })
  return runner.info()
}

async function respond(ctx: ServerContext, res: ServerResponse, status: number, agent: StoredAgent, session?: SessionInfo): Promise<void> {
  const info = session ?? (agent.sessionId === undefined ? undefined : await sessionInfoOf(ctx, agent.sessionId))
  const body: AgentResponse = { agent: ctx.agents.public(agent) }
  if (info) {
    body.session = ctx.projects.withProject(info)
  }
  json(res, status, body)
}

function configOf(info: SessionInfo): AgentConfig {
  return stripUndefined({
    cwd: info.cwd || undefined,
    profile: info.profile,
    model: info.model,
    reasoningEffort: info.effort ?? undefined,
    permissionMode: info.permissionMode,
  })
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
