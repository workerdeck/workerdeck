import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { bookmarksFor, subscribeBookmarks, toggleBookmark } from '../lib/bookmark-store.ts'

export type UseBookmarksResult = {
  bookmarks: readonly string[]
  toggle: (itemId: string) => void
}

const NONE: readonly string[] = Object.freeze([])

export function useBookmarks(sessionKey: string | undefined): UseBookmarksResult {
  const read = useCallback(() => (sessionKey ? bookmarksFor(sessionKey) : NONE), [sessionKey])
  const bookmarks = useSyncExternalStore(subscribeBookmarks, read, () => NONE)
  const toggle = useCallback(
    (itemId: string) => {
      if (sessionKey) {
        toggleBookmark(sessionKey, itemId)
      }
    },
    [sessionKey],
  )
  return useMemo(() => ({ bookmarks, toggle }), [bookmarks, toggle])
}
