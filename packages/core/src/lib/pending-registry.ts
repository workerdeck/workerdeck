export type PendingKind = 'approval' | 'tool_call' | 'execution'

export type SettledBy = 'client' | 'timeout' | 'policy' | 'server'

export type PendingOutcome<T> =
  | { ok: true; value: T; settledBy: SettledBy }
  | { ok: false; reason: string; error: string; settledBy: SettledBy }

export type PendingEntry = {
  id: string
  kind: PendingKind
  createdAt: number
  expiresAt?: number
  meta?: Record<string, unknown>
}

type Slot<T> = PendingEntry & {
  resolve: (outcome: PendingOutcome<T>) => void
  timer?: ReturnType<typeof setTimeout>
}

export type RegisterOptions<T> = {
  id: string
  kind: PendingKind
  timeoutMs?: number
  meta?: Record<string, unknown>
  onSettle?: (outcome: PendingOutcome<T>, entry: PendingEntry) => void
}

export class PendingRequestRegistry {
  #slots = new Map<string, Slot<unknown>>()

  get size(): number {
    return this.#slots.size
  }

  // The outcome promise never rejects: a timeout or cancellation resolves `ok: false`, so a
  // caller feeds the failure back into the agent loop instead of unwinding it.
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

  settle<T>(id: string, value: T, settledBy: SettledBy = 'client'): boolean {
    return this.#settle(id, { ok: true, value, settledBy })
  }

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

  cancelAll(reason: string, error: string, kind?: PendingKind): number {
    let canceled = 0
    // Snapshot first: settling mutates the map being iterated.
    for (const slot of Array.from(this.#slots.values())) {
      if (kind && slot.kind !== kind) {
        continue
      }
      if (this.#settle(slot.id, { ok: false, reason, error, settledBy: 'server' })) {
        canceled += 1
      }
    }
    return canceled
  }

  #settle(id: string, outcome: PendingOutcome<unknown>): boolean {
    const slot = this.#slots.get(id)
    if (!slot) {
      return false
    }
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
