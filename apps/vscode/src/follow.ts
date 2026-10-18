import { followStep, type SessionInfo } from '@workerdeck/protocol'
import type { SessionRef } from './session-surface.ts'

export function followTargetOf(
  session: SessionRef,
  sessions: readonly SessionInfo[],
  successor: string | undefined,
  left: ReadonlySet<string>,
): string | undefined {
  const selection =
    session.agentId === undefined ? undefined : { kind: 'agent' as const, gateway: session.host.id, agentId: session.agentId }
  const rows = sessions.map((info) => ({ hostId: session.host.id, info }))
  return followStep({ selection, shown: session.sessionId, rows, successor, left })
}

export function agentOf(info: Pick<SessionInfo, 'agent' | 'archived'> | undefined): string | undefined {
  return info?.agent && !info.archived ? info.agent.id : undefined
}
