// One lifecycle change at a time per session id, and a gate that keeps new work off a conversation being cut.
export class LifecycleLocks {
  #tails = new Map<string, Promise<void>>()
  // Counted: a retire and a cut may each hold the gate, and one lifting it must not lift the other's.
  #gated = new Map<string, number>()
  #held = new Set<string>()
  readonly startupTimeoutMs: number
  readonly onError: (error: unknown) => void

  constructor(options: { startupTimeoutMs?: number; onError?: (error: unknown) => void } = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000
    this.onError = options.onError ?? (() => {})
  }

  async run<T>(sessionIds: readonly string[], step: () => Promise<T>): Promise<T> {
    const ids = [...new Set(sessionIds)].sort()
    const previous = ids.map((id) => this.#tails.get(id) ?? Promise.resolve())
    let release!: () => void
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    for (const id of ids) {
      this.#tails.set(id, done)
    }
    await Promise.all(previous)
    try {
      return await step()
    } finally {
      release()
      for (const id of ids) {
        if (this.#tails.get(id) === done) {
          this.#tails.delete(id)
        }
      }
    }
  }

  gate(sessionId: string): void {
    this.#gated.set(sessionId, (this.#gated.get(sessionId) ?? 0) + 1)
  }

  ungate(sessionId: string): void {
    const held = (this.#gated.get(sessionId) ?? 0) - 1
    if (held > 0) {
      this.#gated.set(sessionId, held)
    } else {
      this.#gated.delete(sessionId)
    }
  }

  // A gate that outlives one step: a retirement whose close has not finished keeps it until a later pass does.
  hold(sessionId: string): void {
    if (!this.#held.has(sessionId)) {
      this.#held.add(sessionId)
      this.gate(sessionId)
    }
  }

  release(sessionId: string): void {
    if (this.#held.delete(sessionId)) {
      this.ungate(sessionId)
    }
  }

  gated(sessionId: string): boolean {
    return this.#gated.has(sessionId)
  }
}

export const CUT_IN_PROGRESS = 'a new conversation is starting'
