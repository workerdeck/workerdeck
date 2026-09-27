import { SUBAGENT_HISTORY } from '@workerdeck/protocol'

// Ordered by when each key last settled, not when it was first seen: a slow early agent settles after a fast late one.
export class SettledHistory<K> {
  readonly #order = new Set<K>()
  readonly #limit: number

  constructor(limit: number = SUBAGENT_HISTORY) {
    this.#limit = limit
  }

  settle(key: K): K[] {
    this.#order.delete(key)
    this.#order.add(key)
    const evicted: K[] = []
    for (const oldest of this.#order) {
      if (this.#order.size <= this.#limit) {
        break
      }
      this.#order.delete(oldest)
      evicted.push(oldest)
    }
    return evicted
  }

  forget(key: K): void {
    this.#order.delete(key)
  }

  clear(): void {
    this.#order.clear()
  }
}
