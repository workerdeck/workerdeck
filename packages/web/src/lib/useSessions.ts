import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sessionState } from '@workerdeck/protocol'
import type { SessionInfo, SessionRow } from '@workerdeck/protocol'
import { client } from './client.ts'
import { LOCAL_HOST_ID, useUnseen } from './useUnseen.ts'

/**
 * The session registry, polled at a rate that follows what it is showing.
 *
 * A flat 5s was wrong in both directions: too slow to watch a turn run (the
 * status badge and the cost lag visibly behind the panel's own socket), and too
 * fast for a dashboard left open on a screen with nothing running. So the
 * interval follows the list — anything working or awaiting approval tightens it,
 * everything settled relaxes it. Same rule the VS Code extension's model uses.
 *
 * Still REST rather than a socket on purpose: the list is a rollup of every
 * session, and the one live attach per session belongs to the panel.
 */
const IDLE_MS = 5_000
const BUSY_MS = 1_200

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [error, setError] = useState<string | undefined>()
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setSessions(await client.listSessions())
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  const busy = sessions.some((s) => {
    const state = sessionState(s)
    return state === 'working' || state === 'attention'
  })

  // The interval is re-armed whenever the regime changes, not on every poll —
  // a fresh timer per response would drift toward continuous polling.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    void refreshRef.current()
    const timer = setInterval(() => void refreshRef.current(), busy ? BUSY_MS : IDLE_MS)
    return () => clearInterval(timer)
  }, [busy])

  return { sessions, error, loaded, refresh }
}

/** The registry as list rows, each carrying its unread count. */
export function useSessionRows(sessions: SessionInfo[]): SessionRow[] {
  const { unseenFor } = useUnseen()
  return useMemo(
    () =>
      sessions.map((info) => ({
        hostId: LOCAL_HOST_ID,
        hostName: 'Gateway',
        local: true,
        adapter: info.engine ?? 'claude',
        state: sessionState(info),
        info,
        unseen: unseenFor(info),
      })),
    [sessions, unseenFor],
  )
}
