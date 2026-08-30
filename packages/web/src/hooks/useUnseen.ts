import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { Watermarks, unseenCount } from '@workerdeck/protocol'
import type { SessionInfo, Watermark, WatermarkStore } from '@workerdeck/protocol'

/**
 * Unread counts for the dashboard, backed by `localStorage`.
 *
 * The model — monotonic marks, rows rather than turns, the 30-day prune — is
 * `@workerdeck/protocol`'s, shared with the VS Code extension and mirrored on
 * iOS. All that is web-shaped is where the marks are kept and how a component
 * learns one moved.
 *
 * One module-scope instance, because two hooks reading two copies of the marks
 * would each answer from its own stale snapshot.
 */
const KEY = 'workerdeck.watermarks.v1'

/**
 * Marks are keyed `(hostId, sessionId)` by `Watermarks` already, so going
 * multi-gateway needed no storage change and no version bump: the gateway that
 * served this page keeps the id the single-gateway build used
 * (`IMPLICIT_HOST_ID`), and its existing marks keep counting. Added gateways
 * simply introduce new ids, and the model's 30-day prune collects strays from
 * one that gets removed.
 */

const listeners = new Set<() => void>()
let version = 0

const store: WatermarkStore = {
  read: () => {
    try {
      const raw = localStorage.getItem(KEY)
      return raw ? (JSON.parse(raw) as Record<string, Watermark>) : undefined
    } catch {
      // A private-mode browser, or a corrupted entry. Losing the marks costs one
      // over-counted badge; throwing here would cost the whole list.
      return undefined
    }
  },
  write: (marks) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(marks))
    } catch {
      /* quota or private mode — the in-memory cache still serves this session */
    }
    version += 1
    for (const listener of listeners) {
      listener()
    }
  },
}

const watermarks = new Watermarks(store)

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUnseen() {
  // The marks are mutated in place by `Watermarks`, so a version counter is what
  // React can actually compare — the object identity never changes.
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )

  const unseenFor = useCallback(
    (hostId: string, info: SessionInfo) =>
      unseenCount(watermarks.get(hostId, info.id), {
        activityCount: info.activityCount,
        turns: info.numTurns,
      }),
    // `version` is read through the store subscription above; listing it here
    // would need it as a value, and the callback is only ever called during a
    // render that has already re-subscribed.
    [],
  )

  return { unseenFor, watermarks }
}

/**
 * What a session had been read up to, for the panel's catch-up row — or
 * `undefined` for one opened for the first time, which has nothing to catch up
 * on.
 */
export function unseenSince(hostId: string, sessionId: string): { itemCount: number; since: number } | undefined {
  const mark = watermarks.get(hostId, sessionId)
  return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
}

/**
 * Mark a session read while it is on screen.
 *
 * The caller must only call this while the session genuinely IS on screen — a
 * background tab is not being read, and marking it read is exactly how an unread
 * badge quietly stops working. The dashboard's session route is a whole page, so
 * "mounted" is the honest test, with `document.hidden` guarding the tab.
 */
export function useMarkSeen(hostId: string, sessionId: string | undefined) {
  const seen = useRef<{ itemCount?: number; activity?: number; turns?: number }>({})
  return useCallback(
    (reading: { itemCount?: number; activity?: number; turns?: number }) => {
      if (!sessionId || document.hidden) {
        return
      }
      seen.current = { ...seen.current, ...reading }
      watermarks.mark(hostId, sessionId, seen.current)
    },
    [hostId, sessionId],
  )
}

/** The unread total across every gateway, for a caller that wants one number. */
export function useUnseenTotal(rows: { hostId: string; info: SessionInfo }[]): number {
  const { unseenFor } = useUnseen()
  return useMemo(() => rows.reduce((total, r) => total + unseenFor(r.hostId, r.info), 0), [rows, unseenFor])
}
