import type { Runner } from '@workerdeck/core'

export type EngineSleepOptions = {
  afterMs: number
  attachedCount: (sessionId: string) => number
  onError?: (error: unknown, sessionId: string) => void
}

// Armed while a live session sits idle and unwatched; one generation's timers, cleared when its server closes.
export class EngineSleepTimers {
  #options: EngineSleepOptions
  #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #runners = new Map<string, Runner>()
  #closed = false

  constructor(options: EngineSleepOptions) {
    this.#options = options
  }

  get enabled(): boolean {
    return this.#options.afterMs > 0 && !this.#closed
  }

  watch(runner: Runner): (() => void) | undefined {
    if (!this.enabled || !runner.sleep) {
      return undefined
    }
    this.#runners.set(runner.id, runner)
    const unsubscribe = runner.subscribe((event) => {
      if (event.type === 'status_changed') {
        this.#rearm(runner)
      }
    }, runner.info().lastSeq)
    this.#rearm(runner)
    return () => {
      unsubscribe()
      this.#disarm(runner.id)
      if (this.#runners.get(runner.id) === runner) {
        this.#runners.delete(runner.id)
      }
    }
  }

  onDetach(sessionId: string): void {
    const runner = this.#runners.get(sessionId)
    if (runner) {
      this.#rearm(runner)
    }
  }

  close(): void {
    this.#closed = true
    for (const timer of this.#timers.values()) {
      clearTimeout(timer)
    }
    this.#timers.clear()
    this.#runners.clear()
  }

  #rearm(runner: Runner): void {
    this.#disarm(runner.id)
    if (!this.enabled || !this.#sleepable(runner)) {
      return
    }
    const timer = setTimeout(() => {
      this.#timers.delete(runner.id)
      if (!this.enabled || !this.#sleepable(runner)) {
        return
      }
      // A refusal is silent: the next idle, or the next client leaving, arms the timer again.
      runner.sleep?.().catch((error: unknown) => this.#options.onError?.(error, runner.id))
    }, this.#options.afterMs)
    timer.unref?.()
    this.#timers.set(runner.id, timer)
  }

  #sleepable(runner: Runner): boolean {
    const info = runner.info()
    return info.status === 'idle' && info.engineAsleep !== true && this.#options.attachedCount(runner.id) === 0
  }

  #disarm(sessionId: string): void {
    clearTimeout(this.#timers.get(sessionId))
    this.#timers.delete(sessionId)
  }
}
