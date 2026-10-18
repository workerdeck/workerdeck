// One agent lifecycle change at a time per agent, and a gate that keeps new work off a conversation being handed over.
export class AgentHandovers {
  #tails = new Map<string, Promise<void>>()
  #gated = new Set<string>()

  async run<T>(agentIds: readonly string[], step: () => Promise<T>): Promise<T> {
    const ids = [...new Set(agentIds)].sort()
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
    this.#gated.add(sessionId)
  }

  ungate(sessionId: string): void {
    this.#gated.delete(sessionId)
  }

  gated(sessionId: string): boolean {
    return this.#gated.has(sessionId)
  }
}

export const ROTATING = 'conversation is rotating'
