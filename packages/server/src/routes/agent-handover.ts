import { randomUUID } from 'node:crypto'
import type { SessionInfo, SessionStatus } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import type { HandoverIntent, StoredAgent } from '../services/agent-store.ts'
import { isAgentRefusal, type RetireOutcome } from '../services/agents.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ArchivedSessionRecord } from '../services/session-store.ts'
import { startSession } from './agents.ts'
import { sessionInfoOf } from './session-lookup.ts'

const BUSY: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'awaiting_approval', 'parked'])

export type RotateOptions = { prompt?: string; expected?: string; requireIdle?: boolean }

export type Rotation = { agent: StoredAgent; session: SessionInfo }

// The agent's conversation moves to a fresh session: prepare (gate, fence, archive metadata), commit (one agent-store
// write), finish (archive and close the old one, start the new one, send its first message). Recovery reruns finish.
export function rotateAgent(ctx: ServerContext, agentId: string, auth: AuthContext, options: RotateOptions = {}): Promise<Rotation> {
  return ctx.handovers.run([agentId], async () => {
    const agent = ctx.agents.get(agentId)
    if (!agent) {
      fail(404, 'agent not found')
    }
    const from = agent.sessionId
    if (options.expected !== undefined && options.expected !== from) {
      fail(409, `${agent.name} has moved to another conversation`)
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
    const committed = await ctx.agents.commitRotation(agentId, from, intent)
    if (isAgentRefusal(committed)) {
      abandon(ctx, from)
      fail(committed.status, committed.error)
    }
    return await finishRotation(ctx, committed, auth)
  })
}

export function retireAgentSafely(
  ctx: ServerContext,
  agentId: string,
  members: 'release' | 'retire',
  expected?: string,
): Promise<RetireOutcome> {
  const crew = ctx.agents.members(agentId).map((member) => member.id)
  return ctx.handovers.run([agentId, ...crew], async () => {
    const agent = ctx.agents.get(agentId)
    if (!agent) {
      fail(404, 'agent not found')
    }
    if (ctx.agents.members(agentId).some((member) => !crew.includes(member.id))) {
      fail(409, `${agent.name}'s team changed; try again`)
    }
    const from = agent.sessionId
    if (expected !== undefined && expected !== from) {
      fail(409, `${agent.name} has moved to another conversation`)
    }
    const archive = await prepare(ctx, agent, from, undefined)
    const intent: HandoverIntent = {
      op: 'retire',
      ...(from === undefined ? {} : { from }),
      promptState: 'unsent',
      ...(archive ? { archive } : {}),
      startedAt: Date.now(),
    }
    const outcome = await ctx.agents.retire(agentId, members, { expected: from, intent })
    if (isAgentRefusal(outcome)) {
      abandon(ctx, from)
      fail(outcome.status, outcome.error)
    }
    for (const gone of outcome.retired) {
      ctx.teams?.retiring(gone)
    }
    for (const gone of outcome.retired.filter((other) => other.id !== agentId)) {
      const runner = gone.sessionId === undefined ? undefined : ctx.registry.get(gone.sessionId)
      const status = runner?.info().status
      if (runner && status !== 'closed' && status !== 'failed') {
        runner.close('client')
      }
    }
    await finishRetirement(ctx, agentId)
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
        await finishRotation(ctx, current, { ok: true, operator: true, ...(scope ? { scope } : {}) }, true)
      })
    } catch (error) {
      onError(error)
    }
  }
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

async function finishRotation(ctx: ServerContext, agent: StoredAgent, auth: AuthContext, recovering = false): Promise<Rotation> {
  const intent = agent.pending!
  const to = intent.to!
  if (intent.from !== undefined) {
    await archiveAndClose(ctx, intent.from, intent.archive, to)
  }
  const existing = ctx.registry.get(to) ?? (recovering ? await ctx.parking.ensureLive(to).catch(() => undefined) : undefined)
  const uncertain = !existing && intent.promptState !== 'unsent'
  if (!existing) {
    const prompt = uncertain ? undefined : intent.prompt
    if (prompt) {
      settled(await ctx.agents.updatePending(agent.id, { promptState: 'sending' }))
    }
    await startSession(ctx, agent, prompt, auth, to)
    if (prompt) {
      settled(await ctx.agents.updatePending(agent.id, { promptState: 'sent' }))
    }
  }
  let current = settled(await ctx.agents.updatePending(agent.id, null))
  if (uncertain && intent.prompt) {
    current = settled(await ctx.agents.patch(agent.id, (next) => ({ ...next, undelivered: intent.prompt })))
  }
  const session = await sessionInfoOf(ctx, to)
  if (!session) {
    fail(500, 'the new conversation did not start')
  }
  return { agent: current, session }
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

function settled(result: StoredAgent | { status: number; error: string }): StoredAgent {
  if (isAgentRefusal(result)) {
    fail(result.status, result.error)
  }
  return result
}
