export type Listener<T> = (payload: T) => void

/**
 * The handles' listener registry. A throwing listener must never stop the ones queued behind it:
 * these fire from a socket callback, where an escaping error would take the connection with it.
 */
export class Emitter<Events> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(kind: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(kind)
    if (!set) {
      set = new Set()
      this.#listeners.set(kind, set)
    }
    set.add(listener as Listener<never>)
    return () => set.delete(listener as Listener<never>)
  }

  emit<K extends keyof Events>(kind: K, payload: Events[K]): void {
    const set = this.#listeners.get(kind)
    if (!set) {
      return
    }
    for (const listener of set) {
      try {
        ;(listener as Listener<Events[K]>)(payload)
      } catch {}
    }
  }
}

/** 500ms doubling from a zero-based attempt count, capped at 10s. */
export const reconnectDelay = (retries: number): number => Math.min(500 * 2 ** retries, 10_000)
