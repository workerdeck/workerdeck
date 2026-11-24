// A short line a session shows under its name, like a chat status: the agent sets and clears it through `set_status`,
// an operator through `PATCH /sessions/:id`. It stays until changed and clears when the conversation resets.
// `waitingOn: 'human'`: the agent cannot continue without a person. A new label without it clears it.
export type StatusLabel = { text: string; emoji?: string; waitingOn?: StatusWaitingOn; setAt: number }

export type StatusLabelInput = { text: string; emoji?: string; waitingOn?: StatusWaitingOn }

export type StatusWaitingOn = 'human'

export const STATUS_LABEL_TEXT_MAX = 80
export const STATUS_LABEL_EMOJI_MAX = 16
export const AGENT_STATUS_WORDS_MAX = 3
export const AGENT_STATUS_EXAMPLES = ['Running Tests', 'Waiting on CI', 'Needs Relay Key', 'Review iOS', 'Refresh Docs'] as const

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

// What an agent may put in its own status: a glance, Verb Noun, at most three words and no emoji. Returns why a line is
// refused, or undefined. An operator's `PATCH` is not held to it.
export function agentStatusRefusal(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim()
  if (PICTOGRAPHIC.test(line)) {
    return 'no emoji'
  }
  const words = line ? line.split(' ').length : 0
  return words > AGENT_STATUS_WORDS_MAX ? `${words} words, at most ${AGENT_STATUS_WORDS_MAX}` : undefined
}

// Trimmed and capped; an empty text clears. Returns an error string for input a caller must refuse.
export function readStatusLabelInput(input: unknown): StatusLabelInput | null | string {
  if (input === null) {
    return null
  }
  if (typeof input !== 'object' || input === undefined) {
    return 'statusLabel must be an object or null'
  }
  const { text, emoji, waitingOn } = input as { text?: unknown; emoji?: unknown; waitingOn?: unknown }
  if (typeof text !== 'string') {
    return 'statusLabel.text must be a string'
  }
  if (emoji !== undefined && typeof emoji !== 'string') {
    return 'statusLabel.emoji must be a string'
  }
  if (waitingOn !== undefined && waitingOn !== 'human') {
    return "statusLabel.waitingOn must be 'human'"
  }
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) {
    return null
  }
  if (line.length > STATUS_LABEL_TEXT_MAX) {
    return `statusLabel.text is longer than ${STATUS_LABEL_TEXT_MAX} characters`
  }
  const mark = emoji?.trim()
  if (mark && mark.length > STATUS_LABEL_EMOJI_MAX) {
    return `statusLabel.emoji is longer than ${STATUS_LABEL_EMOJI_MAX} characters`
  }
  return { text: line, ...(mark ? { emoji: mark } : {}), ...(waitingOn ? { waitingOn } : {}) }
}
