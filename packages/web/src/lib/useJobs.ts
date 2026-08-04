import { useCallback, useEffect, useRef, useState } from 'react'
import type { JobInfo, QueueStats } from '@workerdeck/protocol'
import { client } from './client.ts'

/**
 * Live view of the server's job queue: jobs stream in over `/queue/ws` (upserted by id),
 * with a slow REST poll as a safety net and for the initial list. `enabled: false` means
 * the server has no queue configured; `live` reflects the WS connection.
 */
export function useJobs(fallbackIntervalMs = 15_000) {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [stats, setStats] = useState<QueueStats | undefined>()
  const [enabled, setEnabled] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const [jobList, queueStats] = await Promise.all([client.listJobs(), client.queueStats()])
      setJobs(jobList)
      setStats(queueStats)
      setEnabled(true)
      setError(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/not configured/i.test(message)) {
        setEnabled(false)
        setError(undefined)
      } else {
        setError(message)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
    timer.current = setInterval(() => void refresh(), fallbackIntervalMs)
    return () => clearInterval(timer.current)
  }, [refresh, fallbackIntervalMs])

  // Attach the WS only once REST confirmed a queue exists — a queue-less server
  // refuses the socket and the handle would loop on reconnect.
  const ready = enabled && stats !== undefined
  useEffect(() => {
    if (!ready) return
    const handle = client.attachQueue()
    const offs = [
      // Reconnects have no replay: re-list to catch anything missed while detached.
      handle.on('attached', () => void refresh()),
      handle.on('stats', setStats),
      handle.on('connectionChange', setLive),
      handle.on('event', (event) => {
        setJobs((prev) => {
          const next = prev.some((j) => j.id === event.job.id)
            ? prev.map((j) => (j.id === event.job.id ? event.job : j))
            : [...prev, event.job]
          return next
        })
      }),
    ]
    return () => {
      for (const off of offs) off()
      handle.detach()
    }
  }, [ready, refresh])

  return { jobs, stats, enabled, live, error, refresh }
}
