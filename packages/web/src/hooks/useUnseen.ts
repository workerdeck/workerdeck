import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { Watermarks, unseenCount } from '@workerdeck/protocol'
import type { SessionInfo, Watermark, WatermarkStore } from '@workerdeck/protocol'

/**
 * Unread counts for the dashboard, backed by `localStorage`. The model — monotonic
 * marks keyed `(hostId, sessionId)`, rows rather than turns, the 30-day prune — is
 * `@workerdeck/protocol`'s, shared with the extension and mirrored on iOS; only
 * the storage is web-shaped.
 *
 * One module-scope instance, because two hooks reading two copies of the marks
 * would each answer from its own stale snapshot.
 */
const KEY = 'workerdeck.watermarks.v1'

const listeners = new Set<() => void>()
let version = 0

const store: WatermarkStore = {
  read: () => {
    try {
      const raw = localStorage.getItem(KEY)
      return raw ? (JSON.parse(raw) as Record<string, Watermark>) : undefined
    } catch {
      // Private mode or a corrupt entry: losing the marks costs one over-counted badge,
      // throwing here would cost the whole list.
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

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useUnseen = () => {
  // `Watermarks` mutates the marks in place, so a version counter is what React can compare.
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
    // `version` is read through the store subscription above, and this callback only ever runs
    // during a render that has already re-subscribed.
    [],
  )

  return { unseenFor, watermarks }
}

/** What a session had been read up to, for the panel's catch-up row; `undefined` for a first open. */
export const unseenSince = (hostId: string, sessionId: string): { itemCount: number; since: number } | undefined => {
  const mark = watermarks.get(hostId, sessionId)
  return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
}

/**
 * Mark a session read while it is on screen — and only then. A background tab is
 * not being read, and marking it read is exactly how an unread badge quietly stops
 * working; `document.hidden` is what guards that here.
 */
export const useMarkSeen = (hostId: string, sessionId: string | undefined) => {
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
export const useUnseenTotal = (rows: { hostId: string; info: SessionInfo }[]): number => {
  const { unseenFor } = useUnseen()
  return useMemo(() => rows.reduce((total, r) => total + unseenFor(r.hostId, r.info), 0), [rows, unseenFor])
}
