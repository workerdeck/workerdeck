import { useSyncExternalStore } from 'react'

/**
 * A module-scope store read through `useSyncExternalStore`. Four of these were hand-rolled
 * with the same `let state` + listener Set + emit loop; what actually differs between them is
 * the polling and socket wiring, which stays with each caller.
 *
 * The snapshot is compared by identity, so `set`/`patch` must always produce a new object —
 * both do.
 */
export type Store<T> = {
  get: () => T
  set: (next: T) => void
  patch: (next: Partial<T>) => void
  subscribe: (listener: () => void) => () => void
  use: () => T
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  const get = () => state
  const emit = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  return {
    get,
    subscribe,
    set: (next) => {
      state = next
      emit()
    },
    patch: (next) => {
      state = { ...state, ...next }
      emit()
    },
    use: () => useSyncExternalStore(subscribe, get, get),
  }
}
