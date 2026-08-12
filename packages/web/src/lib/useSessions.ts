import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { sessionState } from '@workerdeck/protocol'
import type { SessionInfo, SessionRow } from '@workerdeck/protocol'
import { clientFor, currentHosts, isLocal, onHostsChange, type GatewayHost } from './hosts.ts'
import { useUnseen } from './useUnseen.ts'

/**
 * The session registry, polled at a rate that follows what it is showing, and
 * **nudgeable** by anything that already knows better.
 *
 * A flat 5s was wrong in both directions: too slow to watch a turn run (the
 * status badge and the cost lag visibly behind the panel's own socket), and too
 * fast for a dashboard left open on a screen with nothing running. So the
 * interval follows the list — anything working or awaiting approval tightens it,
 * everything settled relaxes it. Same rule the VS Code extension's model uses.
 *
 * Polling alone still loses a race it shouldn't: the *session view* holds a live
 * socket, so it learns a turn started before any poll could, and a create call
 * returns the new session's id before the list has any reason to refetch. Both
 * call `nudgeSessions()`, which is the same escape hatch `SessionsModel.nudge()`
 * is in the extension. Still REST rather than a second socket: the list is a
 * rollup of every session, and the one live attach per session belongs to the
 * panel.
 *
 * A **module-scope store** rather than per-hook state, for the same reason the
 * watermarks are one: two components each holding their own copy would each poll
 * on their own clock and answer from their own stale snapshot, and the nudge
 * would only reach whichever one happened to call it.
 */
const IDLE_MS = 5_000
const BUSY_MS = 1_200
/**
 * Floor between two nudged fetches. `onVitals` fires per streamed delta, so an
 * uncoalesced nudge would be a REST call per token; the poll below is still
 * running underneath, so the worst case of dropping one is the old latency, not
 * a stale list.
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

function emit(next: State) {
  state = next
  for (const listener of listeners) listener()
}

let inFlight: Promise<void> | undefined
let lastFetchAt = 0
let nudgeTimer: ReturnType<typeof setTimeout> | undefined

/** Fetch every gateway now. Concurrent callers share the one pass in flight. */
export function refreshSessions(): Promise<void> {
  inFlight ??= (async () => {
    lastFetchAt = Date.now()
    try {
      const hosts = currentHosts()
      const previous = new Map(state.snapshots.map((s) => [s.host.id, s]))
      const snapshots = await Promise.all(
        hosts.map(async (host): Promise<HostSnapshot> => {
          const client = clientFor(host.id)
          if (!client) return { host, sessions: [], error: 'unusable address' }
          try {
            return { host, sessions: await client.listSessions() }
          } catch (e) {
            // Keep this gateway's last good rows: one failed poll is a blip, and
            // blanking it would be worse than rows a few seconds old.
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
export function nudgeSessions(): void {
  if (nudgeTimer !== undefined) return
  const wait = Math.max(0, NUDGE_MIN_GAP_MS - (Date.now() - lastFetchAt))
  nudgeTimer = setTimeout(() => {
    nudgeTimer = undefined
    void refreshSessions()
  }, wait)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let pollTimer: ReturnType<typeof setInterval> | undefined
let pollRegime: number | undefined

/**
 * One timer for the whole app, re-armed only when the regime changes — a fresh
 * timer per response would drift toward continuous polling.
 */
function arm(busy: boolean) {
  const interval = busy ? BUSY_MS : IDLE_MS
  if (pollTimer !== undefined && pollRegime === interval) return
  if (pollTimer !== undefined) clearInterval(pollTimer)
  pollRegime = interval
  pollTimer = setInterval(() => void refreshSessions(), interval)
}

export function useSessions() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  // Re-poll when a gateway is added, edited or removed rather than waiting out
  // the current interval — the operator just told us the world changed.
  useEffect(() => onHostsChange(() => void refreshSessions()), [])

  const busy = snapshot.snapshots.some((s) =>
    s.sessions.some((info) => {
      const st = sessionState(info)
      return st === 'working' || st === 'attention'
    }),
  )

  useEffect(() => {
    arm(busy)
    if (!state.loaded) void refreshSessions()
  }, [busy])

  return { ...snapshot, refresh: refreshSessions }
}

/**
 * Every gateway's sessions as one list of rows.
 *
 * The gateway is a **facet**, not the frame: protocol's view model groups,
 * filters and sorts by `hostId` already, and `SessionBrowser` lights those
 * controls up on its own once more than one gateway is present.
 */
export function useSessionRows(snapshots: HostSnapshot[]): SessionRow[] {
  const { unseenFor } = useUnseen()
  return useMemo(
    () =>
      snapshots.flatMap(({ host, sessions }) =>
        sessions.map((info) => ({
          hostId: host.id,
          hostName: host.name,
          // The honest answer, not a hardcoded `true`: a session on a remote
          // gateway runs on another machine, and its cwd is that machine's path.
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
