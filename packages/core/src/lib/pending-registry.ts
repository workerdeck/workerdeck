/**
 * One registry for every request that leaves the runner and must come back:
 * permission approvals, browser-bridged tool calls, and deferred executions.
 * They differ only in who answers and how long that takes — the correlation,
 * timeout, idempotent settle, and provenance tagging are identical, so they
 * live here once.
 */

/** What kind of async request this is. Purely descriptive — the mechanics are shared. */
export type PendingKind = 'approval' | 'tool_call' | 'execution'

/** Who settled a request. Mirrors the existing approval vocabulary. */
export type SettledBy = 'client' | 'timeout' | 'policy' | 'server'

export type PendingOutcome<T> =
  | { ok: true; value: T; settledBy: SettledBy }
  | { ok: false; reason: string; error: string; settledBy: SettledBy }

export type PendingEntry = {
  id: string
  kind: PendingKind
  createdAt: number
  /** Epoch ms the timeout policy fires at, when one was set. */
  expiresAt?: number
  /** Caller-supplied descriptor for display/rehydration (tool name, request, ...). */
  meta?: Record<string, unknown>
}

type Slot<T> = PendingEntry & {
  resolve: (outcome: PendingOutcome<T>) => void
  timer?: ReturnType<typeof setTimeout>
}

export type RegisterOptions<T> = {
  id: string
  kind: PendingKind
  /** Fail the request automatically after this long. Omit for no deadline
   * (deferred executions whose watchdog lives elsewhere). */
  timeoutMs?: number
  meta?: Record<string, unknown>
  /** Called when the entry settles, however it settled. For emitting events. */
  onSettle?: (outcome: PendingOutcome<T>, entry: PendingEntry) => void
}

export class PendingRequestRegistry {
  #slots = new Map<string, Slot<unknown>>()

  get size(): number {
    return this.#slots.size
  }

  /**
   * Register a request and get a promise for its outcome. The promise **never
   * rejects**: a timeout or cancellation resolves with `ok: false` so callers
   * feed the failure back into the agent loop instead of unwinding it.
   *
   * Re-registering a live id throws — silently replacing it would strand the
   * first waiter forever.
   */
  register<T>(options: RegisterOptions<T>): Promise<PendingOutcome<T>> {
    if (this.#slots.has(options.id)) {
      throw new Error(`pending request '${options.id}' is already registered`)
    }
    const entry: PendingEntry = {
      id: options.id,
      kind: options.kind,
      createdAt: Date.now(),
      expiresAt: options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs,
      meta: options.meta,
    }
    return new Promise<PendingOutcome<T>>((resolve) => {
      const slot: Slot<T> = {
        ...entry,
        resolve: (outcome) => {
          options.onSettle?.(outcome, entry)
          resolve(outcome)
        },
      }
      if (options.timeoutMs !== undefined) {
        slot.timer = setTimeout(() => {
          this.#settle(options.id, {
            ok: false,
            reason: 'timeout',
            error: `request timed out after ${options.timeoutMs}ms`,
            settledBy: 'timeout',
          })
        }, options.timeoutMs)
        slot.timer.unref?.()
      }
      this.#slots.set(options.id, slot as Slot<unknown>)
    })
  }

  /** Deliver a result. Returns false for unknown or already-settled ids —
   * duplicate and late deliveries are no-ops, never a second application. */
  settle<T>(id: string, value: T, settledBy: SettledBy = 'client'): boolean {
    return this.#settle(id, { ok: true, value, settledBy })
  }

  /** Fail a request. Same idempotence guarantee as {@link settle}. */
  fail(id: string, reason: string, error: string, settledBy: SettledBy = 'server'): boolean {
    return this.#settle(id, { ok: false, reason, error, settledBy })
  }

  has(id: string): boolean {
    return this.#slots.has(id)
  }

  get(id: string): PendingEntry | undefined {
    const slot = this.#slots.get(id)
    return slot && toEntry(slot)
  }

  list(kind?: PendingKind): PendingEntry[] {
    const entries = [...this.#slots.values()].map(toEntry)
    return kind ? entries.filter((e) => e.kind === kind) : entries
  }

  /** Fail everything (optionally of one kind) — session close, turn interrupt. */
  cancelAll(reason: string, error: string, kind?: PendingKind): number {
    let canceled = 0
    // Snapshot ids first: settling mutates the map we would be iterating.
    for (const slot of Array.from(this.#slots.values())) {
      if (kind && slot.kind !== kind) continue
      if (this.#settle(slot.id, { ok: false, reason, error, settledBy: 'server' })) canceled += 1
    }
    return canceled
  }

  #settle(id: string, outcome: PendingOutcome<unknown>): boolean {
    const slot = this.#slots.get(id)
    if (!slot) return false
    clearTimeout(slot.timer)
    this.#slots.delete(id)
    slot.resolve(outcome)
    return true
  }
}

function toEntry(slot: Slot<unknown>): PendingEntry {
  return {
    id: slot.id,
    kind: slot.kind,
    createdAt: slot.createdAt,
    expiresAt: slot.expiresAt,
    meta: slot.meta,
  }
}
