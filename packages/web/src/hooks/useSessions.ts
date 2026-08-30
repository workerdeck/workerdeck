import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { isJobRun, sessionState, type SessionInfo, type SessionRow } from '@workerdeck/protocol'
import { clientFor, currentHosts, isLocal, onHostsChange, type GatewayHost } from '../lib/hosts.ts'
import { useUnseen } from './useUnseen.ts'

/**
 * The session registry, polled at a rate that follows what it is showing (busy
 * tightens it, settled relaxes it) and **nudgeable** by anything that already
 * knows better — the session view's socket learns a turn started before any poll
 * could. Stays REST rather than a second socket: the list is a rollup, and the one
 * live attach per session belongs to the panel.
 *
 * A **module-scope store**, not per-hook state: two copies would poll on two
 * clocks, answer from two snapshots, and a nudge would reach only one of them.
 */
const IDLE_MS = 5_000
const BUSY_MS = 1_200
/**
 * Floor between two nudged fetches: `onVitals` fires per streamed delta, so an
 * uncoalesced nudge would be a REST call per token. The poll runs underneath, so
 * dropping one costs latency, never freshness.
 */
const NUDGE_MIN_GAP_MS = 700

/** One gateway's slice of the list. Kept apart so one dead gateway cannot blank
 * the others — the same discipline `SessionListModel` and `SessionsModel` keep. */
export type HostSnapshot = {
  host: GatewayHost
  sessions: SessionInfo[]
  error?: string
}

type State = { snapshots: HostSnapshot[]; loaded: boolean }

let state: State = { snapshots: [], loaded: false }
const listeners = new Set<() => void>()

const emit = (next: State): void => {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

let inFlight: Promise<void> | undefined
let lastFetchAt = 0
let nudgeTimer: ReturnType<typeof setTimeout> | undefined

/** Fetch every gateway now. Concurrent callers share the one pass in flight. */
export const refreshSessions = (): Promise<void> => {
  inFlight ??= (async () => {
    lastFetchAt = Date.now()
    try {
      const hosts = currentHosts()
      const previous = new Map(state.snapshots.map((s) => [s.host.id, s]))
      const snapshots = await Promise.all(
        hosts.map(async (host): Promise<HostSnapshot> => {
          const client = clientFor(host.id)
          if (!client) {
            return { host, sessions: [], error: 'unusable address' }
          }
          try {
            return { host, sessions: await client.listSessions() }
          } catch (e) {
            // Keep this gateway's last good rows: one failed poll is a blip.
            return {
              host,
              sessions: previous.get(host.id)?.sessions ?? [],
              error: e instanceof Error ? e.message : String(e),
            }
          }
        }),
      )
      emit({ snapshots, loaded: true })
    } finally {
      inFlight = undefined
    }
  })()
  return inFlight
}

/**
 * "Something changed that the poll doesn't know about yet." Coalesced and rate
 * limited, so it is safe to call from a streaming callback.
 */
export const nudgeSessions = (): void => {
  if (nudgeTimer !== undefined) {
    return
  }
  const wait = Math.max(0, NUDGE_MIN_GAP_MS - (Date.now() - lastFetchAt))
  nudgeTimer = setTimeout(() => {
    nudgeTimer = undefined
    void refreshSessions()
  }, wait)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let pollRegime: number | undefined

/**
 * One timer for the whole app, re-armed only when the regime changes — a fresh
 * timer per response would drift toward continuous polling.
 */
const arm = (busy: boolean): void => {
  const interval = busy ? BUSY_MS : IDLE_MS
  if (pollTimer !== undefined && pollRegime === interval) {
    return
  }
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
  }
  pollRegime = interval
  pollTimer = setInterval(() => void refreshSessions(), interval)
}

export const useSessions = () => {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  // Re-poll on a gateway change rather than waiting out the interval.
  useEffect(() => onHostsChange(() => void refreshSessions()), [])

  const busy = snapshot.snapshots.some((s) =>
    s.sessions.some((info) => {
      const st = sessionState(info)
      return st === 'working' || st === 'attention'
    }),
  )

  useEffect(() => {
    arm(busy)
    if (!state.loaded) {
      void refreshSessions()
    }
  }, [busy])

  return { ...snapshot, refresh: refreshSessions }
}

/**
 * Every gateway's sessions as one list of rows. The gateway is a **facet**, not
 * the frame — protocol's view model already groups, filters and sorts by `hostId`.
 *
 * Job runs are left out because this dashboard gives them their own section, where
 * they carry their queue state; the omission is *this composition's*, not the view
 * model's.
 */
export const useSessionRows = (snapshots: HostSnapshot[]): SessionRow[] => {
  const { unseenFor } = useUnseen()
  return useMemo(
    () =>
      snapshots.flatMap(({ host, sessions }) =>
        sessions
          .filter((info) => !isJobRun(info))
          .map((info) => ({
            hostId: host.id,
            hostName: host.name,
            // A session on a remote gateway runs on another machine, and its cwd is that machine's.
            local: isLocal(host),
            adapter: info.engine ?? 'claude',
            state: sessionState(info),
            info,
            unseen: unseenFor(host.id, info),
          })),
      ),
    [snapshots, unseenFor],
  )
}
