// A session goal: a condition the engine keeps working toward across turns (Claude `/goal`, codex thread goals),
// normalized to one record. `setBy` is provenance the gateway enforces: an agent may replace, clear or pause only a
// goal an agent set; a human may change any goal.
export type GoalSetter = { kind: 'human' } | { kind: 'agent'; sessionId: string; name?: string }

export type GoalState = 'active' | 'paused' | 'blocked' | 'met' | 'failed' | 'limited'

export type SessionGoal = {
  text: string
  state: GoalState
  // Only with `state: 'limited'`.
  limit?: 'usage' | 'budget'
  setAt: number
  setBy: GoalSetter
  lastReason?: string
  // Claude only: not-met checks seen.
  checks?: number
  // Codex only.
  tokensUsed?: number
  tokenBudget?: number
  timeUsedSeconds?: number
}

export type GoalNotice = 'set' | 'check_failed' | 'met' | 'failed' | 'limited' | 'blocked' | 'paused' | 'resumed' | 'cleared'

export type GoalCapabilities = { pause: boolean; budget: boolean }

export type GoalInput = { text: string; tokenBudget?: number | null }

export const GOAL_TEXT_MAX = 4000

// Claude reads `/goal <alias>` as a clear, so such a text can never be a goal.
export const GOAL_CLEAR_ALIASES: ReadonlySet<string> = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

export function goalActive(goal: SessionGoal | null | undefined): boolean {
  return goal?.state === 'active'
}

// Returns an error string for input a caller must refuse. `tokenBudget: null` removes a budget.
export function readGoalInput(input: unknown, capabilities: GoalCapabilities | undefined): GoalInput | string {
  if (!capabilities) {
    return 'this engine does not support goals'
  }
  if (typeof input !== 'object' || input === null) {
    return 'goal must be an object'
  }
  const { text, tokenBudget } = input as { text?: unknown; tokenBudget?: unknown }
  if (typeof text !== 'string') {
    return 'goal.text must be a string'
  }
  const line = text.trim()
  if (!line) {
    return 'goal.text must not be empty'
  }
  if (line.length > GOAL_TEXT_MAX) {
    return `goal.text is longer than ${GOAL_TEXT_MAX} characters`
  }
  if (GOAL_CLEAR_ALIASES.has(line.toLowerCase())) {
    return `"${line}" is a clear command, not a goal`
  }
  if (tokenBudget === undefined) {
    return { text: line }
  }
  if (!capabilities.budget) {
    return 'this engine does not support goal token budgets'
  }
  if (tokenBudget === null) {
    return { text: line, tokenBudget: null }
  }
  if (typeof tokenBudget !== 'number' || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
    return 'goal.tokenBudget must be a positive integer or null'
  }
  return { text: line, tokenBudget }
}
