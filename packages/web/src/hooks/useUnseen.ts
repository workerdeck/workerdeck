import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { Watermarks, unseenCount } from '@workerdeck/protocol'
import type { SessionInfo, Watermark, WatermarkStore } from '@workerdeck/protocol'

const KEY = 'workerdeck.watermarks.v1'

const listeners = new Set<() => void>()
let version = 0

const store: WatermarkStore = {
  read: () => {
    try {
      const raw = localStorage.getItem(KEY)
      return raw ? (JSON.parse(raw) as Record<string, Watermark>) : undefined
    } catch {
      // Losing the marks costs one over-counted badge; throwing here would cost the whole list.
      return undefined
    }
  },
  write: (marks) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(marks))
    } catch {}
    version += 1
    for (const listener of listeners) {
      listener()
    }
  },
}

const watermarks = new Watermarks(store)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useUnseen() {
  // `Watermarks` mutates the marks in place, so a version counter is the only thing React can compare.
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
    // `version` is read through the store subscription above, and this only runs in a render that re-subscribed.
    [],
  )

  return { unseenFor, watermarks }
}

export function unseenSince(hostId: string, sessionId: string): { itemCount: number; since: number } | undefined {
  const mark = watermarks.get(hostId, sessionId)
  return mark ? { itemCount: mark.itemCount, since: mark.seenAt } : undefined
}

// A background tab is not being read, and marking it read anyway is how an unread badge quietly stops working.
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

export function useUnseenTotal(rows: { hostId: string; info: SessionInfo }[]): number {
  const { unseenFor } = useUnseen()
  return useMemo(() => rows.reduce((total, r) => total + unseenFor(r.hostId, r.info), 0), [rows, unseenFor])
}
