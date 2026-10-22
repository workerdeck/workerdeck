import type { SessionInfo } from './index.ts'

// One conversation of a session, newest first in a list. `n` counts from 1 and is never reused.
export type AgentConversation = {
  n: number
  startedAt?: number
  endedAt?: number
  title?: string
  transcript?: 'unavailable'
}

// Where a view points: a session by its stable id, and a past conversation of it by `n`. Absent `conversation` is
// the current one, which a cut moves on under the same address.
export type SessionAddress = { id: string; conversation?: number }

export function addressKey(address: SessionAddress): string {
  return address.conversation === undefined ? address.id : `${address.id}#${address.conversation}`
}

export function sameAddress(a: SessionAddress | undefined, b: SessionAddress | undefined): boolean {
  return a?.id === b?.id && a?.conversation === b?.conversation
}

// The current conversation's own number reads as the current address, so a row for it never opens a read-only view.
export function addressOf(id: string, conversation?: number, current?: number): SessionAddress {
  return conversation === undefined || conversation === current ? { id } : { id, conversation }
}

export function isHistorical(address: SessionAddress | undefined): boolean {
  return address?.conversation !== undefined
}

export type ConversationRow = AgentConversation & { current: boolean }

export type RetiredAgentInfo = {
  id: string
  name: string
  owner?: string
  avatar?: string
  retiredAt: number
  conversations: AgentConversation[]
}

export type RetiredAgentsResponse = { retired: RetiredAgentInfo[] }

// What a read-only conversation says above its transcript. `current` is the session's current conversation, absent
// once the session is closed or retired (`kind: 'deleted'` for a retired agent).
export type ArchivedView = {
  kind: 'past' | 'deleted'
  at: number
  current?: number
  unavailable: boolean
}

export function archivedView(
  address: SessionAddress,
  info: Pick<SessionInfo, 'transcript' | 'createdAt'> | undefined,
  current?: { conversation?: number; retired?: boolean },
): ArchivedView | undefined {
  if (address.conversation === undefined || !info) {
    return undefined
  }
  const now = current?.retired ? undefined : current?.conversation
  return {
    kind: current?.retired ? 'deleted' : 'past',
    at: info.createdAt,
    ...(now === undefined || now === address.conversation ? {} : { current: now }),
    unavailable: info.transcript === 'unavailable',
  }
}

export type NewConversationGate = { enabled: true } | { enabled: false; reason: string }

export function newConversationGate(info: Pick<SessionInfo, 'status' | 'sdkSessionId' | 'numTurns'> | undefined): NewConversationGate {
  if (info === undefined) {
    return { enabled: true }
  }
  switch (info.status) {
    case 'running':
    case 'starting':
    case 'parked': {
      return { enabled: false, reason: 'Finish or stop the current turn first' }
    }
    case 'awaiting_approval': {
      return { enabled: false, reason: 'Answer the pending request first' }
    }
    case 'idle': {
      return info.sdkSessionId === undefined && (info.numTurns ?? 0) === 0
        ? { enabled: false, reason: 'This conversation is still new' }
        : { enabled: true }
    }
    default: {
      return { enabled: true }
    }
  }
}

export const NEW_CONVERSATION_HINT = 'Previous chat context is not carried over'

// Clear context is a cut on a gateway, named or not; a past conversation's view (status `closed`) has nothing to clear.
export function clearContextOffered(info: Pick<SessionInfo, 'status'>): boolean {
  return info.status !== 'closed' && info.status !== 'failed'
}

// Sleep stops an engine that holds a conversation; one that never started has nothing to resume, and the gateway refuses.
export function canSleep(info: Pick<SessionInfo, 'capabilities' | 'status' | 'engineAsleep' | 'sdkSessionId'>): boolean {
  return info.capabilities?.engineSleep === true && info.status === 'idle' && info.engineAsleep !== true && info.sdkSessionId !== undefined
}
