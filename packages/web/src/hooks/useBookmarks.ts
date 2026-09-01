import { useCallback, useMemo, useState } from 'react'
import { readJson, writeJson } from '../lib/storage.ts'

const KEY = 'workerdeck.bookmarks.v1'

// Bookmarks are transcript item IDS, not indexes: an index is an artifact of one replay's
// coalescing, an id survives it. Membership per session, stored flat so one key covers every
// host — losing the map costs starred rows, nothing structural, hence readJson's swallow.
type BookmarkMap = Record<string, string[]>

function keyOf(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

export function useBookmarks(hostId: string, sessionId: string) {
  const [map, setMap] = useState<BookmarkMap>(() => readJson<BookmarkMap>(KEY, {}))
  const bookmarks = useMemo(() => map[keyOf(hostId, sessionId)] ?? [], [map, hostId, sessionId])
  const toggle = useCallback(
    (itemId: string) => {
      setMap((previous) => {
        const key = keyOf(hostId, sessionId)
        const current = previous[key] ?? []
        const next = current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
        const merged: BookmarkMap = { ...previous, [key]: next }
        if (next.length === 0) {
          delete merged[key]
        }
        writeJson(KEY, merged)
        return merged
      })
    },
    [hostId, sessionId],
  )
  return { bookmarks, toggle }
}
