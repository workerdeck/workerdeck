import { useEffect, useMemo } from 'react'
import { isJobRun, sessionState, type SessionInfo, type SessionRow } from '@workerdeck/protocol'
import { clientFor, currentHosts, isLocal, onHostsChange, type GatewayHost } from '../lib/hosts.ts'
import { createStore } from '../lib/store.ts'
import { useUnseen } from './useUnseen.ts'

const IDLE_MS = 5_000
const BUSY_MS = 1_200
// `onVitals` fires per streamed delta, so an uncoalesced nudge would be a REST call per token.
const NUDGE_MIN_GAP_MS = 700

// One gateway's slice of the list, kept apart so one dead gateway cannot blank the others.
export type HostSnapshot = {
  host: GatewayHost
  sessions: SessionInfo[]
  error?: string
}

type State = { snapshots: HostSnapshot[]; loaded: boolean }

const store = createStore<State>({ snapshots: [], loaded: false })
const emit = store.set

let inFlight: Promise<void> | undefined
let lastFetchAt = 0
let nudgeTimer: ReturnType<typeof setTimeout> | undefined

// Concurrent callers share the one pass in flight.
export function refreshSessions(): Promise<void> {
  inFlight ??= (async () => {
    lastFetchAt = Date.now()
    try {
      const hosts = currentHosts()
      const previous = new Map(store.get().snapshots.map((s) => [s.host.id, s]))
      const snapshots = await Promise.all(
        hosts.map(async (host): Promise<HostSnapshot> => {
          const client = clientFor(host.id)
          if (!client) {
            return { host, sessions: [], error: 'unusable address' }
          }
          try {
            return { host, sessions: await client.listSessions() }
          } catch (e) {
            // Keep this gateway's last good rows, because one failed poll is a blip.
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

// Coalesced and rate limited, so it is safe to call from a streaming callback.
export function nudgeSessions(): void {
  if (nudgeTimer !== undefined) {
    return
  }
  const wait = Math.max(0, NUDGE_MIN_GAP_MS - (Date.now() - lastFetchAt))
  nudgeTimer = setTimeout(() => {
    nudgeTimer = undefined
    void refreshSessions()
  }, wait)
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let pollRegime: number | undefined

// One timer for the whole app, re-armed only when the regime changes: a fresh timer per response drifts toward
// continuous polling.
function arm(busy: boolean): void {
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

export function useSessions() {
  const snapshot = store.use()
  useEffect(() => onHostsChange(() => void refreshSessions()), [])

  const busy = snapshot.snapshots.some((s) =>
    s.sessions.some((info) => {
      const st = sessionState(info)
      return st === 'working' || st === 'attention'
    }),
  )

  useEffect(() => {
    arm(busy)
    if (!store.get().loaded) {
      void refreshSessions()
    }
  }, [busy])

  return { ...snapshot, refresh: refreshSessions }
}

// Job runs are left out because this dashboard gives them their own section; the omission is this composition's.
export function useSessionRows(snapshots: HostSnapshot[]): SessionRow[] {
  const { unseenFor } = useUnseen()
  return useMemo(
    () =>
      snapshots.flatMap(({ host, sessions }) =>
        sessions
          .filter((info) => !isJobRun(info))
          .map((info) => ({
            hostId: host.id,
            hostName: host.name,
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
