import { useEffect, useSyncExternalStore } from 'react'
import type { JobInfo, QueueStats } from '@workerdeck/protocol'
import { client } from './client.ts'

/**
 * Live view of the primary gateway's job queue: jobs stream in over `/queue/ws`
 * (upserted by id), with a slow REST poll as a safety net and for the initial
 * list. `enabled: false` means the server has no queue configured; `live`
 * reflects the WS connection.
 *
 * A **module-scope store** rather than per-hook state, for the same reason
 * `useSessions` and the watermarks are: the jobs sidebar, the empty detail pane
 * and a job's own page are all on screen at once now, and three copies of this
 * hook would be three queue sockets and three polls answering from three
 * snapshots. The socket is opened when the first subscriber arrives and closed
 * when the last leaves.
 */
const FALLBACK_INTERVAL_MS = 15_000

type State = {
  jobs: JobInfo[]
  stats: QueueStats | undefined
  /** False once the server has told us it has no queue configured. */
  enabled: boolean
  /** The queue socket is connected — otherwise the poll is carrying it. */
  live: boolean
  error: string | undefined
}

let state: State = { jobs: [], stats: undefined, enabled: true, live: false, error: undefined }
const listeners = new Set<() => void>()

function emit(next: Partial<State>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

let inFlight: Promise<void> | undefined

/** Re-list now. Concurrent callers share the one pass in flight. */
export function refreshJobs(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const gateway = client()
      if (!gateway) return
      const [jobs, stats] = await Promise.all([gateway.listJobs(), gateway.queueStats()])
      emit({ jobs, stats, enabled: true, error: undefined })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A queue-less server is a configuration, not a failure — saying so is
      // what lets the UI offer the option rather than an error.
      if (/not configured/i.test(message)) emit({ enabled: false, error: undefined })
      else emit({ error: message })
    } finally {
      inFlight = undefined
    }
  })()
  return inFlight
}

let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined
let detach: (() => void) | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (++subscribers === 1) {
    void refreshJobs()
    timer = setInterval(() => void refreshJobs(), FALLBACK_INTERVAL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (--subscribers === 0) {
      clearInterval(timer)
      timer = undefined
      detach?.()
      detach = undefined
      emit({ live: false })
    }
  }
}

/**
 * Attach the queue socket, but only once REST has confirmed a queue exists — a
 * queue-less server refuses the upgrade and the handle would loop on reconnect.
 * Driven from the hook rather than from `subscribe` because `enabled`/`stats`
 * arrive after the first subscriber does.
 */
function ensureAttached() {
  if (detach || !state.enabled || state.stats === undefined || subscribers === 0) return
  const gateway = client()
  if (!gateway) return
  const handle = gateway.attachQueue()
  const offs = [
    // Reconnects have no replay: re-list to catch anything missed while detached.
    handle.on('attached', () => void refreshJobs()),
    handle.on('stats', (stats) => emit({ stats })),
    handle.on('connectionChange', (live) => emit({ live })),
    handle.on('event', (event) => {
      emit({
        jobs: state.jobs.some((j) => j.id === event.job.id)
          ? state.jobs.map((j) => (j.id === event.job.id ? event.job : j))
          : [...state.jobs, event.job],
      })
    }),
  ]
  detach = () => {
    for (const off of offs) off()
    handle.detach()
  }
}

export function useJobs(): State & { refresh: () => Promise<void> } {
  const value = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  useEffect(ensureAttached, [value.enabled, value.stats])
  return { ...value, refresh: refreshJobs }
}
