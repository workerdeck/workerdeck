import { contextReading, transcriptActivity, type ContextReading, type SessionEvent, type SessionEventBody } from '@workerdeck/protocol'

/**
 * The append-only event log every runner emits through — seq/ts stamping plus
 * the folds `GET /sessions` answers without an attach, stated once instead of
 * per engine: `activityCount` is monotonic across a `conversation_reset` on
 * purpose (an unread cursor, not an item count — see `SessionInfo.activityCount`);
 * the context reading folds here rather than at the fetch sites, so every
 * producer passes the same rule; and a reset records `resetSeq` (which
 * `subscribe()` uses to skip cleared transcript content — the log itself is
 * never truncated) and retires the reading, because the old window is not this
 * conversation's. Fan-out is not here: what runs between the fold and the
 * listeners (Claude's subagent rollup, codex's replay stamp) is per-engine.
 */
export class EventLog {
  #events: SessionEvent[] = []
  #seq = 0
  #activityCount = 0
  #contextUsage: ContextReading | undefined
  #resetSeq = 0
  #lastActivityAt: number | undefined

  get events(): readonly SessionEvent[] {
    return this.#events
  }

  get seq(): number {
    return this.#seq
  }

  get activityCount(): number {
    return this.#activityCount
  }

  get contextUsage(): ContextReading | undefined {
    return this.#contextUsage
  }

  get resetSeq(): number {
    return this.#resetSeq
  }

  get lastActivityAt(): number | undefined {
    return this.#lastActivityAt
  }

  /** Stamp, fold and store one event. The caller fans it out. */
  append(body: SessionEventBody): SessionEvent {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#lastActivityAt = event.ts
    this.#fold(event)
    this.#events.push(event)
    return event
  }

  /** See `Runner.eventAt`. A linear scan: the one caller is a reader pressing
   * "show everything" on one row, so a per-runner seq index would be a map
   * maintained on every emit to save a walk nobody makes twice a minute. */
  at(seq: number): SessionEvent | undefined {
    return this.#events.find((event) => event.seq === seq)
  }

  /**
   * Adopt a parked log verbatim — same seqs, so a client reattaching with
   * `afterSeq` sees one unbroken stream across the teardown — and refold the
   * derived state from it: the log IS the count and the mark, so a rehydrated
   * session cannot disagree with itself. `seq` is passed, never derived: the
   * snapshot may retain fewer events than it stamped (stream deltas are
   * dropped). `lastActivityAt` is carried, not refolded — the stored `ts`
   * values are history, not activity.
   */
  restore(events: readonly SessionEvent[], seq: number, lastActivityAt: number | undefined): void {
    this.#events = [...events]
    this.#seq = seq
    this.#activityCount = 0
    this.#contextUsage = undefined
    this.#resetSeq = 0
    for (const event of this.#events) {
      this.#fold(event)
    }
    this.#lastActivityAt = lastActivityAt
  }

  #fold(event: SessionEvent): void {
    this.#activityCount += transcriptActivity(event)
    this.#contextUsage = contextReading(event) ?? this.#contextUsage
    if (event.type === 'conversation_reset') {
      this.#resetSeq = event.seq
      this.#contextUsage = undefined
    }
  }
}
