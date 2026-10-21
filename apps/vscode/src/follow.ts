import type { SessionInfo } from '@workerdeck/protocol'
import type { SessionRef } from './session-surface.ts'

// Protocol 2 keeps a session's id across a new conversation, so there is nothing left to follow.
export function followTargetOf(
  _session: SessionRef,
  _sessions: readonly SessionInfo[],
  _successor: string | undefined,
  _left: ReadonlySet<string>,
): string | undefined {
  return undefined
}

export function agentOf(info: Pick<SessionInfo, 'agent'> | undefined): string | undefined {
  return info?.agent?.id
}
