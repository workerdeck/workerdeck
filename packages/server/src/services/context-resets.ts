import type { ContextResetDirectory, ContextResetRequest, Runner } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'

export type AgentContextResetOptions = {
  // Whether a session the request and profile say nothing about gets `context_reset`. Off unless set.
  default?: boolean
  minIntervalMs?: number
  maxPerHour?: number
}

export type ContextResetServiceOptions = AgentContextResetOptions & {
  onError?: (error: unknown, sessionId: string) => void
  now?: () => number
  resetTimeoutMs?: number
}

export const CONTEXT_RESET_MIN_INTERVAL_MS = 10 * 60_000
export const CONTEXT_RESET_MAX_PER_HOUR = 3
const HOUR_MS = 60 * 60_000
const RESET_TIMEOUT_MS = 60_000

export const CONTEXT_RESET_SCHEDULED =
  'Reset scheduled. It runs when this turn ends: your conversation is cleared and your prompt becomes the first message of a ' +
  'fresh one. End your turn now and start no new work. If the turn is interrupted or ends in an error, the reset is cancelled.'

// One gateway generation's agent-requested resets: held until the requesting session's turn ends, then run as clear-then-prompt.
export class ContextResetService implements ContextResetDirectory {
  #options: ContextResetServiceOptions
  #runners = new Map<string, Runner>()
  #pending = new Map<string, ContextResetRequest>()
  #running = new Set<string>()
  #history = new Map<string, number[]>()
  #turnFailed = new Set<string>()
  #closed = false

  constructor(options: ContextResetServiceOptions = {}) {
    this.#options = options
  }

  get defaultEnabled(): boolean {
    return this.#options.default === true
  }

  watch(runner: Runner): (() => void) | undefined {
    if (this.#closed) {
      return undefined
    }
    this.#runners.set(runner.id, runner)
    const unsubscribe = runner.subscribe((event) => this.#observe(runner, event), runner.info().lastSeq)
    return () => {
      unsubscribe()
      if (this.#runners.get(runner.id) === runner) {
        this.#runners.delete(runner.id)
        this.#pending.delete(runner.id)
      }
    }
  }

  async request(sessionId: string, request: ContextResetRequest): Promise<string> {
    const runner = this.#runners.get(sessionId)
    if (this.#closed || !runner || runner.info().agentContextReset !== true) {
      throw new Error('context reset is not enabled for this session')
    }
    if (!runner.clearContext) {
      throw new Error('this engine cannot clear its conversation')
    }
    if (this.#pending.has(sessionId) || this.#running.has(sessionId)) {
      throw new Error('a reset is already scheduled for this session')
    }
    const refused = this.#rateRefusal(sessionId)
    if (refused) {
      throw new Error(refused)
    }
    this.#pending.set(sessionId, { prompt: request.prompt, reason: request.reason })
    this.#turnFailed.delete(sessionId)
    return CONTEXT_RESET_SCHEDULED
  }

  close(): void {
    this.#closed = true
    this.#pending.clear()
    this.#runners.clear()
  }

  #rateRefusal(sessionId: string): string | null {
    const now = this.#now()
    const minInterval = this.#options.minIntervalMs ?? CONTEXT_RESET_MIN_INTERVAL_MS
    const maxPerHour = this.#options.maxPerHour ?? CONTEXT_RESET_MAX_PER_HOUR
    const recent = (this.#history.get(sessionId) ?? []).filter((at) => now - at < HOUR_MS)
    const last = recent.at(-1)
    if (last !== undefined && now - last < minInterval) {
      return `refused: the last reset was ${minutes(now - last)} ago and resets need ${minutes(minInterval)} between them; keep working`
    }
    if (maxPerHour <= 0 || recent.length >= maxPerHour) {
      return `refused: this session already reset ${recent.length} time(s) in the last hour (limit ${maxPerHour}); keep working`
    }
    return null
  }

  #observe(runner: Runner, event: SessionEvent): void {
    if (!this.#pending.has(runner.id)) {
      return
    }
    if (event.type === 'turn_result' && event.isError) {
      this.#turnFailed.add(runner.id)
      return
    }
    if (event.type === 'session_closed') {
      this.#pending.delete(runner.id)
      return
    }
    if (event.type !== 'status_changed' || event.status !== 'idle') {
      return
    }
    const request = this.#pending.get(runner.id)!
    this.#pending.delete(runner.id)
    if (this.#turnFailed.delete(runner.id)) {
      return
    }
    void this.#run(runner, request)
  }

  async #run(runner: Runner, request: ContextResetRequest): Promise<void> {
    this.#running.add(runner.id)
    try {
      const reset = nextReset(runner, this.#options.resetTimeoutMs ?? RESET_TIMEOUT_MS)
      try {
        await runner.clearContext!({ agentReason: request.reason })
        await reset.done
      } finally {
        reset.cancel()
      }
      const history = (this.#history.get(runner.id) ?? []).filter((at) => this.#now() - at < HOUR_MS)
      history.push(this.#now())
      this.#history.set(runner.id, history)
      runner.sendMessage(request.prompt)
    } catch (error) {
      this.#options.onError?.(error, runner.id)
    } finally {
      this.#running.delete(runner.id)
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

function nextReset(runner: Runner, timeoutMs: number): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const cancel = (): void => {
    clearTimeout(timer)
    unsubscribe?.()
  }
  const done = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      cancel()
      reject(new Error('the engine did not confirm the reset'))
    }, timeoutMs)
    timer.unref?.()
    unsubscribe = runner.subscribe((event) => {
      if (event.type === 'conversation_reset') {
        cancel()
        resolve()
      }
    }, runner.info().lastSeq)
  })
  return { done, cancel }
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000))
  return `${value} minute${value === 1 ? '' : 's'}`
}
