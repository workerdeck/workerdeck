import { SessionRunner, type Runner, type SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'

export type SessionRegistryOptions = {
  // A returned function is a detach: run when the runner leaves this registry, whether it was closed or handed to
  // another one. Typed `unknown` rather than `void | (() => void)` on purpose: TypeScript only forgives a
  // non-void return against a bare `void`, so the narrower union would break every embedder whose hook is a
  // one-expression arrow (`(r) => seen.push(r)`). The function check is at the retaining end instead.
  onRegister?: (runner: Runner) => unknown
}

export class SessionRegistry {
  #sessions = new Map<string, Runner>()
  #options: SessionRegistryOptions
  #observers = new Set<(runner: Runner) => unknown>()
  // The watchers a registration attached, kept because the objects that attached them are exactly what a hot
  // reload discards: nobody else is in a position to take them off a runner that outlives its generation.
  #detachers = new Map<string, (() => void)[]>()

  constructor(options: SessionRegistryOptions = {}) {
    this.#options = options
  }

  // `onRegister` for a caller that only has the built server - an embedding host, or the CLI. Replays what is already
  // registered so a late observer cannot miss a session, which is the whole difference from reading the option.
  observe(listener: (runner: Runner) => unknown): () => void {
    this.#observers.add(listener)
    for (const runner of this.#sessions.values()) {
      this.#retain(runner.id, listener(runner))
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
      this.#retain(runner.id, this.#options.onRegister?.(runner))
      for (const listener of this.#observers) {
        this.#retain(runner.id, listener(runner))
      }
    }
    return runner
  }

  // For a watcher attached outside `onRegister` - `watchAuthSource` is the one in this package - that must still
  // come off when the runner leaves. Without it a released runner keeps a listener from a discarded generation.
  retain(id: string, detach: () => void): void {
    this.#retain(id, detach)
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
    this.#detach(id)
    return this.#sessions.delete(id)
  }

  evict(id: string): boolean {
    this.#detach(id)
    return this.#sessions.delete(id)
  }

  closeAll(): void {
    for (const runner of this.#sessions.values()) {
      runner.close('server')
    }
  }

  #retain(id: string, detach: unknown): void {
    if (typeof detach !== 'function') {
      return
    }
    const run = detach as () => void
    const existing = this.#detachers.get(id)
    if (existing) {
      existing.push(run)
      return
    }
    this.#detachers.set(id, [run])
  }

  #detach(id: string): void {
    for (const detach of this.#detachers.get(id) ?? []) {
      detach()
    }
    this.#detachers.delete(id)
  }
}
