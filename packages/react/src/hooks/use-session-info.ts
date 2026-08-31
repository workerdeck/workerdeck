import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { SessionInfo } from '@workerdeck/protocol'

export type UseSessionInfoResult = {
  info: SessionInfo | undefined
  loading: boolean
  error: string | undefined
}

export function useSessionInfo(client: WorkerDeckClient, sessionId: string | undefined): UseSessionInfoResult {
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
