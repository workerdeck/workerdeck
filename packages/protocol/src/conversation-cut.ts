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
  history: ConversationSummary[]
  pendingPrompt?: PendingPromptInfo
  startFailed?: ConversationStartFailure
}

export type ConversationHistoryResponse = { info: SessionInfo; events: SessionEvent[] | undefined }

export type SettlePendingPromptRequest = { send: boolean }
