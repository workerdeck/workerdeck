import type { ProfileEngine, SessionEvent, SessionInfo } from './index.ts'

export const GENERATION_HEADER = 'x-workerdeck-generation'

export type ConversationTarget = { profile?: string; cwd?: string; model?: string; scope?: Record<string, string> }

export type NewConversationRequest = { expectedGeneration: number; prompt?: string; target?: ConversationTarget }

export type NewConversationResponse = { session: SessionInfo; conversation: number }

export type PendingPromptState = 'pending' | 'sending' | 'uncertain'

export type PendingPromptInfo = { text: string; n: number; state: PendingPromptState }

export type ConversationStartFailure = { n: number; error: string }

export type ConversationSummary = {
  n: number
  engine: ProfileEngine
  profile?: string
  cwd: string
  engineSessionId?: string
  title?: string
  costUsd?: number
  startedAt?: number
  endedAt: number
  transcript?: 'unavailable'
}

export type ConversationsResponse = {
  conversation?: number
  closed?: true
  history: ConversationSummary[]
  pendingPrompt?: PendingPromptInfo
  startFailed?: ConversationStartFailure
}

export type ConversationHistoryResponse = { info: SessionInfo; events: SessionEvent[] }

export type SettlePendingPromptRequest = { expectedGeneration: number; send: boolean }

export type RetryStartRequest = { expectedGeneration: number }

export const UNCONFIRMED_INPUT_CODE = 'unconfirmed_input'
export const INPUT_CHANGED_CODE = 'input_changed'

// The 409 a cut answers while the engine cannot confirm its queued input was consumed. A person who accepts losing that
// input confirms with `DiscardAndCutRequest`, which binds this conversation and this revision of the pending set.
export type UnconfirmedInputRefusal = {
  error: string
  code: typeof UNCONFIRMED_INPUT_CODE | typeof INPUT_CHANGED_CODE
  conversation: number
  inputRevision: string
  pendingInput: number
  mayIncludePeer: boolean
}

// `POST /sessions/:id/conversations/discard`: refused with 409 `input_changed` once any input arrived since the refusal.
export type DiscardAndCutRequest = { expectedGeneration: number; inputRevision: string; prompt?: string }
