import { SessionRunner, type Runner, type SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'

export type SessionRegistryOptions = {
  onRegister?: (runner: Runner) => void
}

export class SessionRegistry {
  #sessions = new Map<string, Runner>()
  #options: SessionRegistryOptions
  #observers = new Set<(runner: Runner) => void>()

  constructor(options: SessionRegistryOptions = {}) {
    this.#options = options
  }

  // `onRegister` for a caller that only has the built server — an embedding host, or the CLI. Replays what is already
  // registered so a late observer cannot miss a session, which is the whole difference from reading the option.
  observe(listener: (runner: Runner) => void): () => void {
    this.#observers.add(listener)
    for (const runner of this.#sessions.values()) {
      listener(runner)
    }
    return () => void this.#observers.delete(listener)
  }

  create(config: SessionRunnerConfig): Runner {
    return this.adopt(new SessionRunner(config))
  }

  prepare(config: SessionRunnerConfig): Runner {
    return this.register(new SessionRunner(config))
  }

  adopt(runner: Runner): Runner {
    this.register(runner)
    void runner.start()
    return runner
  }

  register(runner: Runner): Runner {
    const existing = this.#sessions.get(runner.id)
    this.#sessions.set(runner.id, runner)
    if (existing !== runner) {
      this.#options.onRegister?.(runner)
      for (const listener of this.#observers) {
        listener(runner)
      }
    }
    return runner
  }

  get(id: string): Runner | undefined {
    return this.#sessions.get(id)
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((r) => r.info())
  }

  remove(id: string): boolean {
    const runner = this.#sessions.get(id)
    if (!runner) {
      return false
    }
    runner.close('server')
    return this.#sessions.delete(id)
  }

  evict(id: string): boolean {
    return this.#sessions.delete(id)
  }

  closeAll(): void {
    for (const runner of this.#sessions.values()) {
      runner.close('server')
    }
  }
}
