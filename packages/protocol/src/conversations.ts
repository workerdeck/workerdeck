import type { AgentInfo } from './agents.ts'
import type { SessionInfo } from './index.ts'

export type AgentConversation = {
  sessionId: string
  startedAt?: number
  endedAt?: number
  title?: string
  transcript?: 'unavailable'
}

export type ConversationSelection =
  | { kind: 'agent'; gateway: string; agentId: string }
  | { kind: 'session'; gateway: string; sessionId: string }

export type ConversationRow = AgentConversation & { current: boolean }

export type AgentConversationsResponse = { conversations: (ConversationRow & { session?: SessionInfo })[] }

export function sessionListed(info: Pick<SessionInfo, 'archived'>): boolean {
  return info.archived !== true
}

export function selectionOf(gateway: string, info: Pick<SessionInfo, 'id' | 'archived' | 'agent'>): ConversationSelection {
  return info.agent && !info.archived
    ? { kind: 'agent', gateway, agentId: info.agent.id }
    : { kind: 'session', gateway, sessionId: info.id }
}

// An agent selection lands on the agent's current conversation; a session selection never moves.
export function followTarget(
  selection: ConversationSelection,
  rows: readonly { hostId: string; info: Pick<SessionInfo, 'id' | 'archived' | 'agent'> }[],
): string | undefined {
  if (selection.kind === 'session') {
    return selection.sessionId
  }
  return rows.find((row) => row.hostId === selection.gateway && !row.info.archived && row.info.agent?.id === selection.agentId)?.info.id
}

export type FollowRow = { hostId: string; info: Pick<SessionInfo, 'id' | 'archived' | 'agent'> }

export type FollowInput = {
  selection: ConversationSelection | undefined
  shown: string
  rows?: readonly FollowRow[]
  successor?: string
  // Sessions this view already followed away from: a list polled before the rotation must not pull it back.
  left: ReadonlySet<string>
}

// Where a view showing `shown` moves next, if anywhere. The list wins because it resolves every rotation the view
// missed; the one-hop successor covers a list that lags.
export function followStep({ selection, shown, rows, successor, left }: FollowInput): string | undefined {
  if (selection?.kind !== 'agent') {
    return undefined
  }
  const listed = rows ? followTarget(selection, rows) : undefined
  return [listed, successor].find((id) => id !== undefined && id !== shown && !left.has(id))
}

export function conversationsOf(agent: Pick<AgentInfo, 'sessionId' | 'pastSessions' | 'conversations'>): ConversationRow[] {
  const known = agent.conversations ?? []
  const listed = new Set(known.map((entry) => entry.sessionId))
  const legacy = [...agent.pastSessions, ...(agent.sessionId === undefined ? [] : [agent.sessionId])]
    .filter((id) => !listed.has(id))
    .map((sessionId): AgentConversation => ({ sessionId }))
  const ordered = [...legacy, ...known]
  return ordered.map((_, index) => {
    const entry = ordered[ordered.length - 1 - index]!
    return { ...entry, current: entry.sessionId === agent.sessionId }
  })
}

export type RetiredAgentInfo = {
  id: string
  name: string
  owner?: string
  avatar?: string
  retiredAt: number
  pastSessions: string[]
  conversations: AgentConversation[]
}

export type RetiredAgentsResponse = { retired: RetiredAgentInfo[] }
