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

export const GOAL_EMOJI = '🎯'

// The state as a phrase a person reads: "Paused", "Token budget reached".
export function goalStateText(goal: Pick<SessionGoal, 'state' | 'limit'>): string {
  switch (goal.state) {
    case 'active': {
      return 'Active'
    }
    case 'paused': {
      return 'Paused'
    }
    case 'blocked': {
      return 'Blocked'
    }
    case 'met': {
      return 'Met'
    }
    case 'failed': {
      return 'Failed'
    }
    case 'limited': {
      return goal.limit === 'budget' ? 'Token budget reached' : 'Usage limit reached'
    }
  }
}

// A card's goal line: the text while active, else the state; a met goal is done and leaves the card.
export function goalCardText(goal: SessionGoal | null | undefined): string | undefined {
  if (!goal || goal.state === 'met') {
    return undefined
  }
  if (goal.state === 'active') {
    return `${GOAL_EMOJI} ${goal.text}`
  }
  return `${GOAL_EMOJI} Goal ${goal.state === 'limited' ? 'stopped' : goal.state}`
}

export type GoalNoticeRow = { level: 'info' | 'error'; text: string }

export function goalNoticeRow(notice: GoalNotice, goal: SessionGoal | null): GoalNoticeRow {
  const reason = goal?.lastReason?.trim()
  const by = goal?.setBy.kind === 'agent' ? ` (set by ${goal.setBy.name ?? 'an agent'})` : ''
  switch (notice) {
    case 'set': {
      return { level: 'info', text: `${GOAL_EMOJI} Goal set${by}: ${goal?.text ?? ''}` }
    }
    case 'check_failed': {
      return { level: 'info', text: `${GOAL_EMOJI} Goal not met yet${reason ? `: ${reason}` : ''}` }
    }
    case 'met': {
      return { level: 'info', text: `${GOAL_EMOJI} Goal met${reason ? `: ${reason}` : ''}` }
    }
    case 'failed': {
      return { level: 'error', text: `${GOAL_EMOJI} Goal failed${reason ? `: ${reason}` : ''}` }
    }
    case 'limited': {
      return { level: 'error', text: `${GOAL_EMOJI} Goal stopped: ${goal ? goalStateText(goal).toLowerCase() : 'limit reached'}` }
    }
    case 'blocked': {
      return { level: 'error', text: `${GOAL_EMOJI} Goal blocked${reason ? `: ${reason}` : ''}` }
    }
    case 'paused': {
      return { level: 'info', text: `${GOAL_EMOJI} Goal paused` }
    }
    case 'resumed': {
      return { level: 'info', text: `${GOAL_EMOJI} Goal resumed` }
    }
    case 'cleared': {
      return { level: 'info', text: `${GOAL_EMOJI} Goal cleared` }
    }
  }
}

// A codex goal left active keeps the engine awake: idle sleep is refused until it is paused or cleared.
export function goalHoldsEngine(info: { goal?: SessionGoal; capabilities?: { goals?: GoalCapabilities } }): boolean {
  return goalActive(info.goal) && info.capabilities?.goals?.pause === true
}

export const GOAL_HOLDS_ENGINE_HINT = 'The goal keeps the engine working and awake; pause or clear it to let the session sleep'

// What a budget field asks for: `undefined` leaves the budget alone (untouched, so a change made elsewhere meanwhile
// stands), `null` removes the one that was shown, a number sets it.
export function goalBudgetChange(field: string, shown: number | undefined): number | null | undefined {
  const value = field.trim()
  if (value === (shown === undefined ? '' : String(shown))) {
    return undefined
  }
  return value ? Number(value) : null
}
