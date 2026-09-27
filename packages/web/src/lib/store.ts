import { useSyncExternalStore } from 'react'

// A module-scope store read through `useSyncExternalStore`. Four of these were hand-rolled
// with the same `let state` + listener Set + emit loop; what actually differs between them is
// the polling and socket wiring, which stays with each caller.
//
// The snapshot is compared by identity, so `set`/`patch` must always produce a new object -
// both do.
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

export type PolledStore<T> = Store<T> & { refresh: () => Promise<void>; watched: () => boolean }

export type PolledStoreOptions<T> = {
  load: (store: Store<T>) => Promise<void>
  intervalMs?: number
  onIdle?: () => void
}

// Concurrent refreshes share the pass in flight; the interval runs only while something is subscribed.
export function createPolledStore<T>(initial: T, { load, intervalMs, onIdle }: PolledStoreOptions<T>): PolledStore<T> {
  const store = createStore(initial)
  let inFlight: Promise<void> | undefined
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = (): Promise<void> => {
    inFlight ??= load(store).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const subscribe = (listener: () => void): (() => void) => {
    const off = store.subscribe(listener)
    if (++subscribers === 1) {
      void refresh()
      if (intervalMs) {
        timer = setInterval(() => void refresh(), intervalMs)
      }
    }
    return () => {
      off()
      if (--subscribers === 0) {
        clearInterval(timer)
        timer = undefined
        onIdle?.()
      }
    }
  }

  return { ...store, subscribe, refresh, watched: () => subscribers > 0, use: () => useSyncExternalStore(subscribe, store.get, store.get) }
}
