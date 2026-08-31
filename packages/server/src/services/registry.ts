import { SessionRunner, type Runner, type SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'

export type SessionRegistryOptions = {
  onRegister?: (runner: Runner) => void
}

export class SessionRegistry {
  #sessions = new Map<string, Runner>()
  #options: SessionRegistryOptions

  constructor(options: SessionRegistryOptions = {}) {
    this.#options = options
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
