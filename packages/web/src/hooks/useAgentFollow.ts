import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { selectionOf, type ConversationSelection } from '@workerdeck/protocol'
import { followStep, type FollowRow } from '@workerdeck/protocol'
import { nudgeSessions, useSessions } from './useSessions.ts'

type Trail = { hostId: string; sessionId: string; selection?: ConversationSelection; left: ReadonlySet<string>; carryFrom?: string }

export type AgentFollow = { carryFrom?: string; superseded: (successor: string) => void }

// `replace`, so Back never lands on the conversation the agent left.
export function useAgentFollow(hostId: string, sessionId: string): AgentFollow {
  const navigate = useNavigate()
  const { snapshots } = useSessions()
  const rows = useMemo<FollowRow[]>(
    () => snapshots.flatMap(({ host, sessions }) => sessions.map((info) => ({ hostId: host.id, info }))),
    [snapshots],
  )
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const trail = useRef<Trail>({ hostId, sessionId, left: new Set() })
  if (trail.current.hostId !== hostId || trail.current.sessionId !== sessionId) {
    trail.current = { hostId, sessionId, left: new Set() }
  }
  if (trail.current.selection === undefined) {
    const row = rows.find((candidate) => candidate.hostId === hostId && candidate.info.id === sessionId)
    if (row) {
      trail.current.selection = selectionOf(hostId, row.info)
    }
  }

  const follow = useCallback(
    (successor?: string) => {
      const from = trail.current
      const target = followStep({ selection: from.selection, shown: from.sessionId, rows: rowsRef.current, successor, left: from.left })
      if (target === undefined) {
        return
      }
      trail.current = {
        hostId: from.hostId,
        sessionId: target,
        selection: from.selection,
        left: new Set([...from.left, from.sessionId]),
        carryFrom: from.sessionId,
      }
      void navigate({ to: '/sessions/$hostId/$sessionId', params: { hostId: from.hostId, sessionId: target }, replace: true })
    },
    [navigate],
  )

  useEffect(() => follow(), [rows, follow])

  const superseded = useCallback(
    (successor: string) => {
      nudgeSessions()
      follow(successor)
    },
    [follow],
  )

  return { carryFrom: trail.current.carryFrom, superseded }
}
