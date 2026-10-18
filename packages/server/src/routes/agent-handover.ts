import { randomUUID } from 'node:crypto'
import type { Runner } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, errorMessage, type SessionInfo, type SessionStatus } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { HandoverIntent, StoredAgent } from '../services/agent-store.ts'
import { isAgentRefusal, type AgentRefusal, type RetireOutcome } from '../services/agents.ts'
import type { AuthContext } from '../services/auth.ts'
import { isArchived, type ArchivedSessionRecord } from '../services/session-store.ts'
import { startSession } from './agents.ts'
import { sessionInfoOf } from './session-lookup.ts'

const BUSY: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'awaiting_approval', 'parked'])

export type RotateOptions = { prompt?: string; expected: string | undefined; requireIdle?: boolean }

export type Rotation = { agent: StoredAgent; session: SessionInfo }

type Startup = { kind: 'ready' } | { kind: 'failed'; error: string }

// The agent's conversation moves to a fresh session: prepare (gate, fence, archive metadata), commit (one agent-store
// write), finish (archive and close the old one, start the new one, keep the intent until the new one is durable).
export function rotateAgent(ctx: ServerContext, agentId: string, auth: AuthContext, options: RotateOptions): Promise<Rotation> {
  return ctx.handovers.run([agentId], async () => {
    const agent = ctx.agents.get(agentId)
    if (!agent) {
      fail(404, 'agent not found')
    }
    const from = agent.sessionId
    if (options.expected !== from) {
      fail(409, `${agent.name} has moved to another conversation`)
    }
    if (agent.pending) {
      fail(409, unfinished(agent))
    }
    const status = from === undefined ? undefined : ctx.registry.get(from)?.info().status
    if (options.requireIdle && status !== undefined && BUSY.has(status)) {
      fail(409, `${agent.name} is busy; start a new conversation once it is idle`)
    }
    const to = randomUUID()
    const archive = await prepare(ctx, agent, from, to)
    const intent: HandoverIntent = {
      op: 'rotate',
      ...(from === undefined ? {} : { from }),
      to,
      ...(options.prompt ? { prompt: options.prompt } : {}),
      promptState: 'unsent',
      ...(archive ? { archive } : {}),
      startedAt: Date.now(),
    }
    const committed = await commitOrAbandon(ctx, [from], () => ctx.agents.commitRotation(agentId, from, intent))
    return await finishRotation(ctx, committed, auth)
  })
}

// Starts a committed conversation whose first start failed, under the same id: never a second rotation.
export function retryStart(ctx: ServerContext, agentId: string, auth: AuthContext): Promise<Rotation> {
  return ctx.handovers.run([agentId], async () => {
    const agent = ctx.agents.get(agentId)
    if (!agent) {
      fail(404, 'agent not found')
    }
    const intent = agent.pending
    if (intent?.op !== 'rotate' || intent.to === undefined) {
      fail(409, `${agent.name} has no new conversation waiting to start`)
    }
    const stuck = ctx.registry.get(intent.to)
    const status = stuck?.info().status
    if (stuck && status !== 'failed' && status !== 'closed') {
      fail(409, `${agent.name}'s new conversation is still starting`)
    }
    if (stuck) {
      ctx.parking.release(stuck.id)
      ctx.registry.remove(stuck.id)
    }
    const cleared = settled(
      await ctx.agents.updatePending(agentId, {}, (next) => {
        const { startError: _error, ...rest } = next.pending!
        return { ...next, pending: rest }
      }),
    )
    return await finishRotation(ctx, cleared, auth)
  })
}

// The first message a crash left uncertain: sent again or dropped on the user's word, once.
export function settleUndelivered(ctx: ServerContext, agentId: string, send: boolean): Promise<StoredAgent> {
  return ctx.handovers.run([agentId], async () => {
    const agent = ctx.agents.get(agentId)
    if (!agent) {
      fail(404, 'agent not found')
    }
    const prompt = agent.undelivered
    if (prompt === undefined) {
      fail(404, 'nothing is waiting to be sent')
    }
    const sessionId = agent.sessionId
    if (send) {
      if (sessionId === undefined || agent.pending || ctx.handovers.gated(sessionId)) {
        fail(409, `${agent.name} has no conversation to send it to`)
      }
      const runner = await ctx.parking.ensureLive(sessionId)
      const now = ctx.agents.get(agentId)
      if (!runner || now?.sessionId !== sessionId || now.undelivered !== prompt) {
        fail(409, `${agent.name} has no conversation to send it to`)
      }
      runner.sendMessage(prompt)
    }
    return settled(await ctx.agents.patch(agentId, ({ undelivered: _gone, ...next }) => next))
  })
}

export function retireAgentSafely(
  ctx: ServerContext,
  agentId: string,
  members: 'release' | 'retire',
  expected: string | undefined,
): Promise<RetireOutcome> {
  const crew = ctx.agents.members(agentId).map((member) => member.id)
  return ctx.handovers.run([agentId, ...crew], async () => {
    const agent = ctx.agents.get(agentId)
    if (!agent) {
      fail(404, 'agent not found')
    }
    const team = ctx.agents.members(agentId)
    if (team.some((member) => !crew.includes(member.id))) {
      fail(409, `${agent.name}'s team changed; try again`)
    }
    if (expected !== agent.sessionId) {
      fail(409, `${agent.name} has moved to another conversation`)
    }
    const leaving = members === 'retire' ? [agent, ...team] : [agent]
    const prepared: Array<string | undefined> = []
    const intents = new Map<string, HandoverIntent>()
    try {
      for (const gone of leaving) {
        const from = gone.sessionId
        const archive = await prepare(ctx, gone, from, undefined)
        prepared.push(from)
        intents.set(gone.id, {
          op: 'retire',
          ...(from === undefined ? {} : { from }),
          promptState: 'unsent',
          ...(archive ? { archive } : {}),
          startedAt: Date.now(),
        })
      }
    } catch (error) {
      prepared.forEach((from) => abandon(ctx, from))
      throw error
    }
    const outcome = await commitOrAbandon(ctx, prepared, () => ctx.agents.retire(agentId, members, { expected, intents }))
    const retired = new Set(outcome.retired.map((gone) => gone.id))
    for (const gone of leaving.filter((other) => !retired.has(other.id))) {
      abandon(ctx, gone.sessionId)
    }
    for (const gone of outcome.retired) {
      ctx.teams?.retiring(gone)
    }
    for (const gone of outcome.retired) {
      await finishRetirement(ctx, gone.id)
    }
    return outcome
  })
}

// Committed changes left behind by a crash, finished before the gateway serves anything.
export async function recoverHandovers(ctx: ServerContext, onError: (error: unknown) => void): Promise<void> {
  for (const agent of ctx.agents.unfinished()) {
    try {
      await ctx.handovers.run([agent.id], async () => {
        const current = ctx.agents.get(agent.id) ?? ctx.agents.tombstone(agent.id)
        if (!current?.pending) {
          return
        }
        if (current.pending.op === 'retire') {
          await finishRetirement(ctx, current.id)
          return
        }
        const scope = current.pending.archive?.info.scope
        await finishRotation(ctx, current, { ok: true, operator: true, ...(scope ? { scope } : {}) })
      })
    } catch (error) {
      onError(error)
    }
  }
}

function unfinished(agent: StoredAgent): string {
  return agent.pending?.startError === undefined
    ? `${agent.name} is still finishing its last change`
    : `${agent.name}'s new conversation did not start; retry starting it first`
}

async function prepare(ctx: ServerContext, agent: StoredAgent, from: string | undefined, to: string | undefined) {
  if (from === undefined) {
    return undefined
  }
  ctx.handovers.gate(from)
  try {
    await ctx.parking.fence(from)
    const live = ctx.registry.get(from)?.info()
    const ref = live ? ctx.agents.decorate(live).agent : undefined
    return await ctx.parking.archiveOf(from, { agentId: agent.id, ...(ref ? { agent: ref } : {}), ...(to ? { supersededBy: to } : {}) })
  } catch (error) {
    abandon(ctx, from)
    throw error
  }
}

// Nothing was committed when the write refuses or throws, so the old conversations go back to normal.
async function commitOrAbandon<T>(
  ctx: ServerContext,
  froms: Array<string | undefined>,
  commit: () => Promise<T | AgentRefusal>,
): Promise<T> {
  let result: T | AgentRefusal
  try {
    result = await commit()
  } catch (error) {
    froms.forEach((from) => abandon(ctx, from))
    throw error
  }
  if (isAgentRefusal(result)) {
    froms.forEach((from) => abandon(ctx, from))
    fail(result.status, result.error)
  }
  return result
}

function abandon(ctx: ServerContext, from: string | undefined): void {
  if (from !== undefined) {
    ctx.parking.unfence(from)
    ctx.handovers.ungate(from)
  }
}

async function archiveAndClose(ctx: ServerContext, from: string, staged: ArchivedSessionRecord | undefined, to: string | undefined) {
  const runner = ctx.registry.get(from)
  if (to !== undefined) {
    runner?.supersede?.(to)
  }
  await ctx.parking.fence(from)
  const archive = staged ?? (await ctx.parking.archiveOf(from, to === undefined ? {} : { supersededBy: to }))
  if (archive) {
    await ctx.parking.saveArchive(archive)
  }
  if (runner) {
    ctx.registry.remove(from)
  }
  ctx.handovers.ungate(from)
}

// The intent stays until the successor is durable: a stored record to resume, or a start that needs none. A record
// that exists is never replaced by a fresh engine conversation, and an uncertain first message is never resent.
async function finishRotation(ctx: ServerContext, agent: StoredAgent, auth: AuthContext): Promise<Rotation> {
  const intent = agent.pending!
  const to = intent.to!
  if (intent.from !== undefined) {
    await archiveAndClose(ctx, intent.from, intent.archive, to)
  }
  const live = ctx.registry.get(to)
  const stored = live ? null : await ctx.parking.get(to)
  const kept = stored !== null && !isArchived(stored)
  const uncertain = intent.prompt !== undefined && (intent.promptState === 'sending' || (intent.promptState === 'sent' && !kept))
  if (kept) {
    return await confirm(ctx, agent.id, to, uncertain ? intent.prompt : undefined)
  }
  let runner = live
  const prompt = live || intent.promptState !== 'unsent' ? undefined : intent.prompt
  if (!runner) {
    if (prompt) {
      settled(await ctx.agents.updatePending(agent.id, { promptState: 'sending' }))
    }
    try {
      await startSession(ctx, agent, prompt, auth, to)
    } catch (error) {
      settled(await ctx.agents.updatePending(agent.id, { startError: errorMessage(error), promptState: intent.promptState }))
      throw error
    }
    if (prompt) {
      settled(await ctx.agents.updatePending(agent.id, { promptState: 'sent' }))
    }
    runner = ctx.registry.get(to)!
  }
  const lost = uncertain ? intent.prompt : undefined
  const startup = startupOf(ctx, runner, prompt !== undefined)
  const early = await within(startup, ctx.handovers.startupTimeoutMs)
  if (early) {
    return await settleStartup(ctx, agent.id, to, lost, early)
  }
  void startup
    .then((late) => ctx.handovers.run([agent.id], () => settleLate(ctx, agent.id, to, lost, late)))
    .catch((error: unknown) => ctx.handovers.onError(error))
  return { agent: ctx.agents.get(agent.id) ?? agent, session: runner.info() }
}

async function settleStartup(
  ctx: ServerContext,
  agentId: string,
  to: string,
  lost: string | undefined,
  startup: Startup,
): Promise<Rotation> {
  if (startup.kind === 'failed') {
    settled(await ctx.agents.updatePending(agentId, { startError: startup.error }))
    fail(502, `the new conversation did not start: ${startup.error}`)
  }
  return await confirm(ctx, agentId, to, lost)
}

async function settleLate(ctx: ServerContext, agentId: string, to: string, lost: string | undefined, startup: Startup): Promise<void> {
  const agent = ctx.agents.get(agentId)
  if (agent?.pending?.to !== to || agent.pending.startError !== undefined) {
    return
  }
  if (startup.kind === 'failed') {
    settled(await ctx.agents.updatePending(agentId, { startError: startup.error }))
    return
  }
  await confirm(ctx, agentId, to, lost)
}

async function confirm(ctx: ServerContext, agentId: string, to: string, lost: string | undefined): Promise<Rotation> {
  const agent = settled(
    await ctx.agents.updatePending(agentId, null, (next) => (lost === undefined ? next : { ...next, undelivered: lost })),
  )
  const session = await sessionInfoOf(ctx, to)
  if (!session) {
    fail(500, 'the new conversation did not start')
  }
  return { agent, session }
}

// Ready once the engine has named a conversation the gateway saved (a first message went out), or once it left
// `starting` when there is nothing to resume yet; failed when it fails or closes first.
function startupOf(ctx: ServerContext, runner: Runner, wantsIdentity: boolean): Promise<Startup> {
  return new Promise((resolve) => {
    let reason: string | undefined
    let done = false
    let unsubscribe: (() => void) | undefined
    const finish = (startup: Startup): void => {
      done = true
      unsubscribe?.()
      if (startup.kind === 'failed') {
        resolve(startup)
        return
      }
      void ctx.parking.flush(runner.id).then(() => resolve(startup))
    }
    const check = (): void => {
      if (done) {
        return
      }
      const info = runner.info()
      if (info.status === 'failed' || info.status === 'closed') {
        finish({ kind: 'failed', error: reason ?? 'the new conversation stopped while starting' })
        return
      }
      const resumable = (info.capabilities ?? ENGINE_CAPABILITIES[engineOf(info)]).resume
      if (!(wantsIdentity && resumable ? info.sdkSessionId === undefined : info.status === 'starting')) {
        finish({ kind: 'ready' })
      }
    }
    unsubscribe = runner.subscribe((event) => {
      if (event.type === 'session_error') {
        reason = event.message
      }
      check()
    })
    if (done) {
      unsubscribe()
    }
    check()
  })
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function finishRetirement(ctx: ServerContext, agentId: string): Promise<void> {
  const tombstone = ctx.agents.tombstone(agentId)
  const intent = tombstone?.pending
  if (!intent) {
    return
  }
  if (intent.from !== undefined) {
    await archiveAndClose(ctx, intent.from, intent.archive, undefined)
  }
  settled(await ctx.agents.updatePending(agentId, null))
}

function settled(result: StoredAgent | AgentRefusal): StoredAgent {
  if (isAgentRefusal(result)) {
    fail(result.status, result.error)
  }
  return result
}
