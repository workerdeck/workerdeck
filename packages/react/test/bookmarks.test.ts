import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOKMARKS_STORAGE_KEY, bookmarksFor, resetBookmarkStore, toggleBookmark } from '../src/lib/bookmark-store.ts'
import { useBookmarks } from '../src/hooks/use-bookmarks.ts'
import { renderHook } from './hook-runner.ts'

class MemoryStorage {
  readonly data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
}

function stored(storage: MemoryStorage): Record<string, string[]> {
  return JSON.parse(storage.getItem(BOOKMARKS_STORAGE_KEY) ?? '{}') as Record<string, string[]>
}

function storageEvent(key: string | null): Event {
  return Object.assign(new Event('storage'), { key })
}

let storage: MemoryStorage
let win: EventTarget

beforeEach(() => {
  storage = new MemoryStorage()
  win = new EventTarget()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', win)
  resetBookmarkStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetBookmarkStore()
})

describe('bookmark store', () => {
  it('toggles membership per session and drops an emptied session', () => {
    toggleBookmark('h:s1', 'a')
    toggleBookmark('h:s1', 'b')
    toggleBookmark('h:s2', 'c')
    toggleBookmark('h:s1', 'a')
    expect(stored(storage)).toEqual({ 'h:s1': ['b'], 'h:s2': ['c'] })
    toggleBookmark('h:s2', 'c')
    expect(stored(storage)).toEqual({ 'h:s1': ['b'] })
  })

  it('writes against storage as it stands, so another tab is not clobbered', () => {
    toggleBookmark('h:s1', 'a')
    storage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify({ 'h:s1': ['a'], 'h:s2': ['other-tab'] }))
    toggleBookmark('h:s1', 'b')
    expect(stored(storage)).toEqual({ 'h:s1': ['a', 'b'], 'h:s2': ['other-tab'] })
  })

  it('keeps working in memory when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    toggleBookmark('k', 'x')
    expect(bookmarksFor('k')).toEqual(['x'])
  })

  it('shrugs off a corrupt stored value', () => {
    storage.setItem(BOOKMARKS_STORAGE_KEY, '{nope')
    expect(bookmarksFor('k')).toEqual([])
    toggleBookmark('k', 'x')
    expect(stored(storage)).toEqual({ k: ['x'] })
  })
})

describe('useBookmarks', () => {
  it('returns one stable empty array and follows toggles', () => {
    const hook = renderHook(() => useBookmarks('h:s1'))
    const empty = hook.current.bookmarks
    const toggle = hook.current.toggle
    hook.rerender()
    expect(hook.current.bookmarks).toBe(empty)
    expect(hook.current.toggle).toBe(toggle)
    toggle('a')
    expect(hook.current.bookmarks).toEqual(['a'])
    hook.unmount()
  })

  it('picks up another tab through the storage event', () => {
    const hook = renderHook(() => useBookmarks('h:s1'))
    storage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify({ 'h:s1': ['from-elsewhere'] }))
    win.dispatchEvent(storageEvent(BOOKMARKS_STORAGE_KEY))
    expect(hook.current.bookmarks).toEqual(['from-elsewhere'])
    hook.unmount()
  })

  it('does not re-render one session for a write to another', () => {
    const hook = renderHook(() => useBookmarks('h:s1'))
    hook.current.toggle('a')
    const before = hook.current.bookmarks
    toggleBookmark('h:s2', 'z')
    expect(hook.current.bookmarks).toBe(before)
    hook.unmount()
  })

  it('is inert without a session key', () => {
    const hook = renderHook(() => useBookmarks(undefined))
    hook.current.toggle('a')
    expect(hook.current.bookmarks).toEqual([])
    expect(storage.getItem(BOOKMARKS_STORAGE_KEY)).toBeNull()
    hook.unmount()
  })
})
