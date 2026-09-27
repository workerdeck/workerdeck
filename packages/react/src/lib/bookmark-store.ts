export const BOOKMARKS_STORAGE_KEY = 'workerdeck.bookmarks.v1'

type BookmarkMap = Record<string, readonly string[]>
type StorageListener = (event: { key: string | null }) => void
type StorageEventTarget = {
  addEventListener: (type: 'storage', listener: StorageListener) => void
  removeEventListener: (type: 'storage', listener: StorageListener) => void
}

const EMPTY: readonly string[] = Object.freeze([])
const listeners = new Set<() => void>()
let loaded: BookmarkMap | undefined
let detachStorageEvent: (() => void) | undefined

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

function storageEvents(): StorageEventTarget | undefined {
  const target = (globalThis as { window?: Partial<StorageEventTarget> }).window
  return typeof target?.addEventListener === 'function' ? (target as StorageEventTarget) : undefined
}

function readStored(): BookmarkMap | undefined {
  try {
    const raw = storage()?.getItem(BOOKMARKS_STORAGE_KEY)
    if (raw == null) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    const map: Record<string, readonly string[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        map[key] = value.filter((id): id is string => typeof id === 'string')
      }
    }
    return map
  } catch {
    return undefined
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

// Unchanged lists keep their identity, so a write to one session never re-renders another.
function adopt(next: BookmarkMap): void {
  const previous = loaded ?? {}
  const merged: Record<string, readonly string[]> = {}
  for (const [key, ids] of Object.entries(next)) {
    const held = previous[key]
    merged[key] = held && sameIds(held, ids) ? held : ids
  }
  loaded = merged
}

function current(): BookmarkMap {
  if (loaded === undefined) {
    adopt(readStored() ?? {})
  }
  return loaded ?? {}
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function bookmarksFor(sessionKey: string): readonly string[] {
  return current()[sessionKey] ?? EMPTY
}

// Read-modify-write against storage as it stands now, so a second tab's toggles survive this one's.
export function toggleBookmark(sessionKey: string, itemId: string): void {
  const base = readStored() ?? current()
  const held = base[sessionKey] ?? EMPTY
  const ids = held.includes(itemId) ? held.filter((id) => id !== itemId) : [...held, itemId]
  const next: Record<string, readonly string[]> = { ...base, [sessionKey]: ids }
  if (ids.length === 0) {
    delete next[sessionKey]
  }
  try {
    storage()?.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(next))
  } catch {}
  adopt(next)
  notify()
}

function onStorage(event: { key: string | null }): void {
  if (event.key !== null && event.key !== BOOKMARKS_STORAGE_KEY) {
    return
  }
  const stored = readStored()
  if (stored) {
    adopt(stored)
    notify()
  }
}

export function subscribeBookmarks(listener: () => void): () => void {
  listeners.add(listener)
  const target = storageEvents()
  if (listeners.size === 1 && target) {
    target.addEventListener('storage', onStorage)
    detachStorageEvent = () => target.removeEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      detachStorageEvent?.()
      detachStorageEvent = undefined
    }
  }
}

export function resetBookmarkStore(): void {
  loaded = undefined
}
