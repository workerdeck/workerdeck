import type { GoalDirectory, GoalToolTarget, Runner } from '@workerdeck/core'
import {
  ENGINE_CAPABILITIES,
  peerOps,
  readGoalInput,
  type GoalCapabilities,
  type GoalInput,
  type GoalSetter,
  type GoalState,
  type SessionGoal,
  type SessionInfo,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import { refuseJobInput } from '../lib/permissions.ts'
import { engineOf } from '../lib/profile-env.ts'
import { scopeMatches } from '../lib/scope.ts'
import { restored } from '../routes/session-upgrade.ts'
import { CUT_IN_PROGRESS } from './lifecycle-locks.ts'

export type GoalChange = { kind: 'set'; goal: unknown } | { kind: 'clear' } | { kind: 'pause'; paused: unknown }

type VettedChange = { kind: 'set'; input: GoalInput } | { kind: 'clear' } | { kind: 'pause'; paused: boolean }

export type GoalIssued = { outcome: Promise<SessionGoal | null> }

export type GoalWait = { done: true; goal: SessionGoal | null } | { done: false }

export type GoalServiceOptions = {
  // How long a caller waits for the engine to confirm before answering `pending`: a Claude session mid-turn applies a
  // goal only after the turn, and the agent's own tool call is part of that turn.
  confirmWaitMs?: number
  onError?: (error: unknown, sessionId: string) => void
}

export const GOAL_CONFIRM_WAIT_MS = 5000
export const HUMAN_SETTER: GoalSetter = { kind: 'human' }

// A human goal is locked against agents only while it is still in play.
const FINISHED: ReadonlySet<GoalState> = new Set(['met', 'failed'])

const VERBS = { set: 'replace', clear: 'clear', pause: 'pause' } as const

type Reach = { id: string; label: string; self: boolean; conversation: number }

// One path for every goal change: the human routes (REST, WS) and the agents' `goal_*` tools.
export class GoalService implements GoalDirectory {
  #ctx: () => ServerContext
  #options: GoalServiceOptions

  constructor(ctx: () => ServerContext, options: GoalServiceOptions = {}) {
    this.#ctx = ctx
    this.#options = options
  }

  // Validates, wakes a dormant session, and issues the change under the lifecycle lock; the engine's confirmation is
  // awaited outside it. `guard` is the caller's own authority and conversation check, re-run inside the lock.
  async change(id: string, change: GoalChange, setter: GoalSetter, guard: () => void | Promise<void>): Promise<GoalIssued> {
    const ctx = this.#ctx()
    const live = ctx.registry.get(id)
    const info = live?.info() ?? (await ctx.parking.get(id))?.info
    if (!info) {
      fail(409, 'the session has no running conversation')
    }
    const vetted = this.#vet(info, change, setter)
    if (!live && vetted.kind !== 'set' && !info.goal) {
      if (vetted.kind === 'pause') {
        fail(409, 'the session has no goal to pause')
      }
      return { outcome: Promise.resolve(null) }
    }
    const runner = live ?? (await this.#wake(id))
    return await ctx.locks.run([id], async () => {
      await guard()
      if (ctx.locks.gated(id)) {
        fail(409, CUT_IN_PROGRESS)
      }
      if (ctx.registry.get(id) !== runner) {
        fail(409, 'the session changed while its goal was being changed; retry')
      }
      return { outcome: issue(runner, this.#vet(runner.info(), change, setter), setter) }
    })
  }

  async within(sessionId: string, outcome: Promise<SessionGoal | null>): Promise<GoalWait> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<GoalWait>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), this.#options.confirmWaitMs ?? GOAL_CONFIRM_WAIT_MS)
    })
    try {
      const waited = await Promise.race([outcome.then((goal): GoalWait => ({ done: true, goal })), timeout])
      if (!waited.done) {
        outcome.catch((error: unknown) => this.#options.onError?.(error, sessionId))
      }
      return waited
    } finally {
      clearTimeout(timer)
    }
  }

  async get(from: string, request: GoalToolTarget): Promise<string> {
    const ctx = this.#ctx()
    const reach = await this.#reach(from, request.target)
    const info = ctx.registry.get(reach.id)?.info() ?? (await ctx.parking.get(reach.id))?.info
    return info?.goal ? `Goal on ${reach.label}: ${describeGoal(info.goal)}` : `No goal on ${reach.label}.`
  }

  async set(from: string, request: GoalToolTarget & { text: string; tokenBudget?: number | null }): Promise<string> {
    const { text, tokenBudget } = request
    return await this.#tool(
      from,
      request.target,
      { kind: 'set', goal: tokenBudget === undefined ? { text } : { text, tokenBudget } },
      (reach, goal) => (goal ? `Goal set on ${reach.label}: ${describeGoal(goal)}` : `Goal set on ${reach.label}.`),
    )
  }

  async clear(from: string, request: GoalToolTarget): Promise<string> {
    return await this.#tool(from, request.target, { kind: 'clear' }, (reach) => `Goal cleared on ${reach.label}.`)
  }

  async pause(from: string, request: GoalToolTarget & { paused: boolean }): Promise<string> {
    const verb = request.paused ? 'paused' : 'resumed'
    return await this.#tool(from, request.target, { kind: 'pause', paused: request.paused }, (reach, goal) =>
      goal ? `Goal ${verb} on ${reach.label}: ${describeGoal(goal)}` : `Goal ${verb} on ${reach.label}.`,
    )
  }

  async #tool(
    from: string,
    target: string | undefined,
    change: GoalChange,
    answer: (reach: Reach, goal: SessionGoal | null) => string,
  ): Promise<string> {
    const ctx = this.#ctx()
    const caller = ctx.registry.get(from)
    const reach = await this.#reach(from, target)
    const setter: GoalSetter = { kind: 'agent', sessionId: from, ...agentName(ctx, from) }
    const { outcome } = await this.change(reach.id, change, setter, async () => {
      if (!caller || ctx.registry.get(from) !== caller) {
        fail(409, 'your session changed while the goal was being changed')
      }
      const current = ctx.records.conversationOf(reach.id) ?? 1
      if (current !== reach.conversation) {
        fail(409, `${reach.label} moved on to conversation ${current}; check its goal again`)
      }
      if (!reach.self && !(await this.#reaches(caller, reach.id))) {
        fail(403, reachRefusal(target))
      }
    })
    const waited = await this.within(reach.id, outcome)
    if (waited.done) {
      return answer(reach, waited.goal)
    }
    return reach.self
      ? 'Goal change requested; it takes effect when your current turn ends.'
      : `Goal change requested on ${reach.label}; it is mid-turn, so the change takes effect when that turn ends.`
  }

  // An agent reaches its own session, and a lead reaches its members, by session id or name, under the peer rule
  // (scope, owners, a member running without prompts). Anything else is refused.
  async #reach(from: string, target: string | undefined): Promise<Reach> {
    const ctx = this.#ctx()
    const caller = ctx.registry.get(from)
    if (!caller) {
      throw new Error(`unknown session: ${from}`)
    }
    const conversationOf = (id: string): number => ctx.records.conversationOf(id) ?? 1
    const agent = ctx.agents.get(from)
    const wanted = target?.trim().toLowerCase()
    if (wanted === undefined || wanted === from.toLowerCase() || wanted === agent?.name.toLowerCase()) {
      return { id: from, label: 'your session', self: true, conversation: conversationOf(from) }
    }
    const member = agent
      ? ctx.agents.members(from).find((row) => row.id.toLowerCase() === wanted || row.name.toLowerCase() === wanted)
      : undefined
    if (!member || !(await this.#reaches(caller, member.id))) {
      throw new Error(reachRefusal(target))
    }
    return { id: member.id, label: member.name, self: false, conversation: conversationOf(member.id) }
  }

  // Membership and the peer rule, read afresh: the lead check runs again inside the lock, where a member that left the
  // team, or a scope or owner change, must refuse the call.
  async #reaches(caller: Runner, memberId: string): Promise<boolean> {
    const ctx = this.#ctx()
    if (ctx.agents.get(memberId)?.lead !== caller.id) {
      return false
    }
    const stored = ctx.registry.get(memberId)?.info() ?? (await ctx.parking.get(memberId))?.info
    if (!stored) {
      return false
    }
    const fromInfo = ctx.projects.withProject(caller.info())
    const toInfo = ctx.projects.withProject(stored)
    return scopeMatches(fromInfo.scope, toInfo.scope) && peerOps(fromInfo, toInfo, ctx.owners.multi()).send
  }

  #vet(info: SessionInfo, change: GoalChange, setter: GoalSetter): VettedChange {
    const ctx = this.#ctx()
    const capabilities = goalCapabilities(info)
    if (!capabilities) {
      fail(501, `the ${engineOf(info)} engine has no goals`)
    }
    const locked = refuseJobInput(info, ctx.options.disableBypassPermissions)
    if (locked) {
      fail(409, locked)
    }
    if (setter.kind === 'agent' && info.goal?.setBy.kind === 'human' && !FINISHED.has(info.goal.state)) {
      fail(403, `the human set this goal and it is not finished; an agent cannot ${VERBS[change.kind]} it`)
    }
    if (change.kind === 'clear') {
      return change
    }
    if (change.kind === 'pause') {
      if (typeof change.paused !== 'boolean') {
        fail(400, 'paused must be a boolean')
      }
      if (!capabilities.pause) {
        fail(400, `the ${engineOf(info)} engine cannot pause a goal`)
      }
      if (!info.goal) {
        fail(409, 'the session has no goal to pause')
      }
      return { kind: 'pause', paused: change.paused }
    }
    const input = readGoalInput(change.goal, capabilities)
    if (typeof input === 'string') {
      fail(400, input)
    }
    return { kind: 'set', input }
  }

  async #wake(id: string): Promise<Runner> {
    const ctx = this.#ctx()
    const runner = await ctx.parking.ensureLive(id)
    if (!runner) {
      fail(409, ctx.parking.fenced(id) ? CUT_IN_PROGRESS : 'the session could not be woken')
    }
    await restored(runner)
    return runner
  }
}

export function goalCapabilities(info: SessionInfo): GoalCapabilities | undefined {
  return (info.capabilities ?? ENGINE_CAPABILITIES[engineOf(info)]).goals
}

export function describeGoal(goal: SessionGoal): string {
  const state = goal.state === 'limited' ? `limited (${goal.limit ?? 'usage'})` : goal.state
  const facts = [
    state,
    goal.checks ? `${goal.checks} failed check${goal.checks === 1 ? '' : 's'}` : undefined,
    goal.tokensUsed === undefined
      ? undefined
      : `${goal.tokensUsed}${goal.tokenBudget === undefined ? '' : ` of ${goal.tokenBudget}`} tokens`,
    goal.setBy.kind === 'human' ? 'set by the human' : `set by ${goal.setBy.name ?? goal.setBy.sessionId}`,
  ].filter((fact) => fact !== undefined)
  const reason = goal.lastReason ? ` Last check: ${goal.lastReason}` : ''
  return `${goal.text} [${facts.join(', ')}]${reason}`
}

function reachRefusal(target: string | undefined): string {
  return `${target} is not a member of a team you lead: you can change your own goal, and a lead its members' goals`
}

function agentName(ctx: ServerContext, sessionId: string): { name?: string } {
  const name = ctx.agents.get(sessionId)?.name
  return name === undefined ? {} : { name }
}

function issue(runner: Runner, change: VettedChange, setter: GoalSetter): Promise<SessionGoal | null> {
  const engine = engineOf(runner.info())
  switch (change.kind) {
    case 'set': {
      if (!runner.setGoal) {
        fail(501, `the ${engine} engine cannot set a goal`)
      }
      return runner.setGoal(change.input, setter)
    }
    case 'clear': {
      if (!runner.clearGoal) {
        fail(501, `the ${engine} engine cannot clear a goal`)
      }
      return runner.clearGoal().then(() => null)
    }
    case 'pause': {
      if (!runner.pauseGoal) {
        fail(501, `the ${engine} engine cannot pause a goal`)
      }
      return runner.pauseGoal(change.paused)
    }
  }
}
