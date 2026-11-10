import type { ContextResetDirectory, ContextResetRequest, Runner } from '@workerdeck/core'
import { isJobRun, type SessionEvent } from '@workerdeck/protocol'
import { UNCONFIRMED_INPUT } from './conversation-cuts.ts'

export type AgentContextResetOptions = {
  // Whether a session the request and profile say nothing about gets `context_reset`. Off unless set.
  default?: boolean
  minIntervalMs?: number
  maxPerHour?: number
}

export type ResetKind = 'context_reset' | 'peer_reset'

// A lead's reset of its member. `guard` is asked again when the turn ends, since the member may have started waiting on
// the human meanwhile; `done` runs once the cut did, to hand the lead's prompt over as a peer message.
export type MemberResetRequest = { reason: string; guard?: () => Promise<string | undefined>; done?: () => void }

type PendingReset = ContextResetRequest & { kind: ResetKind; guard?: () => Promise<string | undefined>; done?: () => void }

export type ContextResetServiceOptions = AgentContextResetOptions & {
  // A reset is a conversation cut under the same id (named or not), its prompt the first message of the next one. Settles
  // once the cut ran, and rejects when it did not; resolving on admission alone would count a reset that never happened.
  // `guard` is a member reset's refusal check, for the cut to ask again under its lock.
  cut?: (sessionId: string, prompt: string, reason: string, kind: ResetKind, guard?: () => Promise<string | undefined>) => Promise<void>
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

// One gateway generation's agent-requested resets: held until the requesting session's turn ends, then run as a cut (or, with
// no gateway cut wired, clear-then-prompt).
export class ContextResetService implements ContextResetDirectory {
  #options: ContextResetServiceOptions
  #runners = new Map<string, Runner>()
  #pending = new Map<string, PendingReset>()
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
    this.#schedule(runner, { prompt: request.prompt, reason: request.reason, kind: 'context_reset' }, 'keep working')
    return CONTEXT_RESET_SCHEDULED
  }

  // No `agentContextReset` grant on the member: the authority is its lead's, checked by the caller. The rate limits are the
  // member's own, shared with its self-resets. Throws the refusal.
  requestMember(sessionId: string, request: MemberResetRequest): void {
    const runner = this.#runners.get(sessionId)
    if (this.#closed || !runner) {
      throw new Error('the member is not running on this gateway')
    }
    this.#schedule(runner, { prompt: '', reason: request.reason, kind: 'peer_reset', guard: request.guard, done: request.done }, 'try later')
  }

  #schedule(runner: Runner, request: PendingReset, onRate: string): void {
    const sessionId = runner.id
    if (isJobRun(runner.info())) {
      throw new Error('a job run cannot reset its conversation')
    }
    if (!runner.clearContext && !this.#options.cut) {
      throw new Error('this engine cannot clear its conversation')
    }
    if ((runner.pendingInput?.() ?? 0) > 0 && runner.inputConfirmable?.() === false) {
      throw new Error(`refused: ${UNCONFIRMED_INPUT}`)
    }
    if (this.#pending.has(sessionId) || this.#running.has(sessionId)) {
      throw new Error('a reset is already scheduled for this session')
    }
    const refused = this.#rateRefusal(sessionId, onRate)
    if (refused) {
      throw new Error(refused)
    }
    this.#pending.set(sessionId, request)
    this.#turnFailed.delete(sessionId)
    // Asked from outside a turn, the idle it waits for has already happened; the reply still goes out first.
    if (runner.info().status === 'idle') {
      setTimeout(() => this.#settle(runner), 0).unref?.()
    }
  }

  close(): void {
    this.#closed = true
    this.#pending.clear()
    this.#runners.clear()
  }

  #rateRefusal(key: string, onRate: string): string | null {
    const now = this.#now()
    const minInterval = this.#options.minIntervalMs ?? CONTEXT_RESET_MIN_INTERVAL_MS
    const maxPerHour = this.#options.maxPerHour ?? CONTEXT_RESET_MAX_PER_HOUR
    const recent = (this.#history.get(key) ?? []).filter((at) => now - at < HOUR_MS)
    const last = recent.at(-1)
    if (last !== undefined && now - last < minInterval) {
      return `refused: the last reset was ${minutes(now - last)} ago and resets need ${minutes(minInterval)} between them; ${onRate}`
    }
    if (maxPerHour <= 0 || recent.length >= maxPerHour) {
      return `refused: this session already reset ${recent.length} time(s) in the last hour (limit ${maxPerHour}); ${onRate}`
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
    if (event.type === 'status_changed' && event.status === 'idle') {
      this.#settle(runner)
    }
  }

  #settle(runner: Runner): void {
    const request = this.#pending.get(runner.id)
    if (!request || this.#runners.get(runner.id) !== runner || runner.info().status !== 'idle') {
      return
    }
    this.#pending.delete(runner.id)
    if (this.#turnFailed.delete(runner.id)) {
      return
    }
    void this.#run(runner, request)
  }

  async #run(runner: Runner, request: PendingReset): Promise<void> {
    this.#running.add(runner.id)
    try {
      const refused = await request.guard?.()
      if (refused) {
        throw new Error(`the reset was dropped: ${refused}`)
      }
      if (this.#options.cut) {
        await this.#options.cut(runner.id, request.prompt, request.reason, request.kind, request.guard)
        this.#record(runner.id)
        request.done?.()
        return
      }
      if (!runner.clearContext) {
        throw new Error('this engine cannot clear its conversation')
      }
      const reset = nextReset(runner, this.#options.resetTimeoutMs ?? RESET_TIMEOUT_MS)
      try {
        await runner.clearContext({ agentReason: request.reason })
        await reset.done
      } finally {
        reset.cancel()
      }
      this.#record(runner.id)
      if (request.prompt) {
        runner.sendMessage(request.prompt)
      }
      request.done?.()
    } catch (error) {
      this.#options.onError?.(error, runner.id)
    } finally {
      this.#running.delete(runner.id)
    }
  }

  #record(key: string): void {
    const history = (this.#history.get(key) ?? []).filter((at) => this.#now() - at < HOUR_MS)
    history.push(this.#now())
    this.#history.set(key, history)
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
