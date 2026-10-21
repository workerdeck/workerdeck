// Remembers recent prompt ids per session so a resend after a dropped socket runs once. Bounded across the
// whole gateway; an id that ages out runs again, which is the behaviour of a client that never sends one.
// What became of a prompt id in one conversation: it ran, or it was refused before the engine saw it.
export type PromptOutcome = 'executed' | 'notDelivered'

export class PromptAcks {
  readonly #seen = new Map<string, Promise<void>>()
  readonly #outcomes = new Map<string, PromptOutcome>()
  readonly #max: number

  constructor(max = 4096) {
    this.#max = max
  }

  // Runs `handle` the first time this id arrives for the session; a repeat waits for that first run instead.
  // A failed run is forgotten, so a resend tries again.
  run(sessionId: string, clientId: string, handle: () => Promise<void>): Promise<void> {
    const key = `${sessionId}\u0000${clientId}`
    const known = this.#seen.get(key)
    if (known) {
      return known.catch(() => {})
    }
    const run = handle()
    this.#seen.set(key, run)
    run.then(
      () => this.record(sessionId, clientId, 'executed'),
      () => this.#seen.delete(key),
    )
    if (this.#seen.size > this.#max) {
      this.#seen.delete(this.#seen.keys().next().value!)
    }
    return run
  }

  // Undefined once evicted, or for an id this process never saw: the caller must not guess.
  outcome(sessionId: string, clientId: string): PromptOutcome | undefined {
    return this.#outcomes.get(`${sessionId}\u0000${clientId}`)
  }

  record(sessionId: string, clientId: string, outcome: PromptOutcome): void {
    const key = `${sessionId}\u0000${clientId}`
    if (this.#outcomes.get(key) === 'executed') {
      return
    }
    this.#outcomes.set(key, outcome)
    if (this.#outcomes.size > this.#max) {
      this.#outcomes.delete(this.#outcomes.keys().next().value!)
    }
  }
}
