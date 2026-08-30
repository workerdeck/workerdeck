import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { SessionInfo } from '@workerdeck/protocol'

export type UseSessionInfoResult = {
  info: SessionInfo | undefined
  /** True until the first answer — distinguishes "still asking" from "no such session". */
  loading: boolean
  /** Set when the gateway refused; `info` stays undefined. */
  error: string | undefined
}

/**
 * The registry's record of one session, over REST.
 *
 * Separate from {@link useClaudeSession} on purpose: that hook attaches a
 * WebSocket and streams a transcript, which is far more than a caller needs to
 * know a session's `cwd` or title — and a second attach would be a second
 * client on the bridge, which is the one thing the bridge's "asks the first
 * attached client" rule cannot tolerate.
 *
 * Fetched once per session id. The record is registry state, not a live feed;
 * anything that changes during a run arrives on the session's event stream.
 */
export const useSessionInfo = (client: WorkerDeckClient, sessionId: string | undefined): UseSessionInfoResult => {
  const [info, setInfo] = useState<SessionInfo | undefined>()
  const [loading, setLoading] = useState(!!sessionId)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!sessionId) {
      setInfo(undefined)
      setLoading(false)
      setError(undefined)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(undefined)
    // The previous session's record must not linger under the new id — a stale
    // cwd would root a file tree in the wrong project.
    setInfo(undefined)
    client
      .getSession(sessionId)
      .then((next) => {
        if (cancelled) {
          return
        }
        setInfo(next)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) {
          return
        }
        setError(e instanceof Error ? e.message : 'Session not found')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, sessionId])

  return { info, loading, error }
}
