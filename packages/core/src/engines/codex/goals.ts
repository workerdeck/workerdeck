import type { GoalNotice, GoalSetter, GoalState, SessionGoal } from '@workerdeck/protocol'
import { JsonRpcError } from './jsonrpc.ts'
import type { AppServerThreadGoal, AppServerThreadGoalStatus } from './types.ts'

export type GoalStamp = Pick<AppServerThreadGoal, 'createdAt' | 'updatedAt' | 'timeUsedSeconds' | 'tokensUsed'>

const STATES: Record<AppServerThreadGoalStatus, Pick<SessionGoal, 'state' | 'limit'>> = {
  active: { state: 'active' },
  paused: { state: 'paused' },
  blocked: { state: 'blocked' },
  usageLimited: { state: 'limited', limit: 'usage' },
  budgetLimited: { state: 'limited', limit: 'budget' },
  complete: { state: 'met' },
}

const NOTICES: Record<GoalState, GoalNotice> = {
  active: 'resumed',
  paused: 'paused',
  blocked: 'blocked',
  met: 'met',
  failed: 'failed',
  limited: 'limited',
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function threadGoalOf(value: unknown): AppServerThreadGoal | undefined {
  const goal = value as Partial<AppServerThreadGoal> | null | undefined
  if (!goal || typeof goal.threadId !== 'string' || typeof goal.objective !== 'string' || !goal.status || !(goal.status in STATES)) {
    return undefined
  }
  if (!finite(goal.createdAt) || !finite(goal.updatedAt)) {
    return undefined
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: finite(goal.tokenBudget) ? goal.tokenBudget : null,
    tokensUsed: finite(goal.tokensUsed) ? goal.tokensUsed : 0,
    timeUsedSeconds: finite(goal.timeUsedSeconds) ? goal.timeUsedSeconds : 0,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  }
}

export function sessionGoal(goal: AppServerThreadGoal, setBy: GoalSetter): SessionGoal {
  const { state, limit } = STATES[goal.status]
  return {
    text: goal.objective,
    state,
    ...(limit ? { limit } : {}),
    setAt: goal.createdAt * 1000,
    setBy,
    tokensUsed: goal.tokensUsed,
    ...(goal.tokenBudget !== null && goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    timeUsedSeconds: goal.timeUsedSeconds,
  }
}

export function sameGoalIdentity(goal: SessionGoal, engine: AppServerThreadGoal): boolean {
  return goal.setAt === engine.createdAt * 1000 && goal.text === engine.objective
}

function sameSetter(a: GoalSetter, b: GoalSetter): boolean {
  if (a.kind === 'human' || b.kind === 'human') {
    return a.kind === b.kind
  }
  return a.sessionId === b.sessionId && a.name === b.name
}

export function sameGoal(a: SessionGoal, b: SessionGoal): boolean {
  return (
    a.text === b.text &&
    a.state === b.state &&
    a.limit === b.limit &&
    a.setAt === b.setAt &&
    a.tokensUsed === b.tokensUsed &&
    a.tokenBudget === b.tokenBudget &&
    a.timeUsedSeconds === b.timeUsedSeconds &&
    sameSetter(a.setBy, b.setBy)
  )
}

// Usage ticks change only the counters: they earn no notice.
export function goalNotice(previous: SessionGoal | null, next: SessionGoal): GoalNotice | undefined {
  if (!previous || previous.setAt !== next.setAt || previous.text !== next.text) {
    return 'set'
  }
  if (previous.state !== next.state || previous.limit !== next.limit) {
    return NOTICES[next.state]
  }
  return undefined
}

export function goalStamp(goal: AppServerThreadGoal): GoalStamp {
  return { createdAt: goal.createdAt, updatedAt: goal.updatedAt, timeUsedSeconds: goal.timeUsedSeconds, tokensUsed: goal.tokensUsed }
}

export function olderThan(goal: AppServerThreadGoal, stamp: GoalStamp): boolean {
  for (const key of ['createdAt', 'updatedAt', 'timeUsedSeconds', 'tokensUsed'] as const) {
    if (goal[key] !== stamp[key]) {
      return goal[key] < stamp[key]
    }
  }
  return false
}

function goalsUnsupported(error: JsonRpcError): boolean {
  return error.code === -32601 || (error.code === -32600 && /unknown variant `thread\/goal/.test(error.message))
}

export function goalRefusal(error: unknown): Error {
  if (!(error instanceof JsonRpcError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  if (goalsUnsupported(error)) {
    return new GoalsUnsupportedError(`this codex app-server does not support goals: ${error.message}`)
  }
  return new Error(`codex refused the goal change: ${error.message}`, { cause: error })
}

export class GoalsUnsupportedError extends Error {
  override readonly name = 'GoalsUnsupportedError'
}
