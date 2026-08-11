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
 * The gateway's id in the shared row shape. The dashboard is served same-origin
 * by the one gateway it talks to, so there is exactly one — but the shape is
 * multi-gateway (the VS Code sidebar lists several), and a constant is what
 * keeps the marks keyed the same way everywhere.
 */
export const LOCAL_HOST_ID = 'gateway'

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
    for (const listener of listeners) listener()
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
    (info: SessionInfo) =>
      unseenCount(watermarks.get(LOCAL_HOST_ID, info.id), {
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
export function unseenSince(sessionId: string): { itemCount: number; since: number } | undefined {
  const mark = watermarks.get(LOCAL_HOST_ID, sessionId)
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
export function useMarkSeen(sessionId: string | undefined) {
  const seen = useRef<{ itemCount?: number; activity?: number; turns?: number }>({})
  return useCallback(
    (reading: { itemCount?: number; activity?: number; turns?: number }) => {
      if (!sessionId || document.hidden) return
      seen.current = { ...seen.current, ...reading }
      watermarks.mark(LOCAL_HOST_ID, sessionId, seen.current)
    },
    [sessionId],
  )
}

/** The unread total, for a caller that wants one number (a tab title, say). */
export function useUnseenTotal(sessions: SessionInfo[]): number {
  const { unseenFor } = useUnseen()
  return useMemo(() => sessions.reduce((total, s) => total + unseenFor(s), 0), [sessions, unseenFor])
}
