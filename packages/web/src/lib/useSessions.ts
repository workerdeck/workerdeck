import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '@workerdeck/protocol'
import { client } from './client.ts'

/** Poll the server's session registry. */
export function useSessions(intervalMs = 5000) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [error, setError] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setSessions(await client.listSessions())
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    timer.current = setInterval(() => void refresh(), intervalMs)
    return () => clearInterval(timer.current)
  }, [refresh, intervalMs])

  return { sessions, error, refresh }
}
