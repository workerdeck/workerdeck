import {
  contextReading,
  logCoalesceKey,
  transcriptActivity,
  transcriptProse,
  type ChecklistItem,
  type ContextReading,
  type SessionEvent,
  type SessionEventBody,
  type SessionGoal,
  type StatusLabel,
} from '@workerdeck/protocol'

export class EventLog {
  #events: SessionEvent[] = []
  #seq = 0
  #activityCount = 0
  #proseCount = 0
  #contextUsage: ContextReading | undefined
  #checklist: ChecklistItem[] | undefined
  #statusLabel: StatusLabel | null | undefined
  #goal: SessionGoal | null | undefined
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

  // The unread badge's unit - see `transcriptProse`. Folded here so a restored log recomputes it.
  get proseCount(): number {
    return this.#proseCount
  }

  get contextUsage(): ContextReading | undefined {
    return this.#contextUsage
  }

  get checklist(): ChecklistItem[] | undefined {
    return this.#checklist
  }

  // `undefined` until this log has seen a set or a reset, so the runner falls back to the label it was built with.
  get statusLabel(): StatusLabel | null | undefined {
    return this.#statusLabel
  }

  // Like `statusLabel`: `undefined` until this log has seen a goal change or a reset.
  get goal(): SessionGoal | null | undefined {
    return this.#goal
  }

  get resetSeq(): number {
    return this.#resetSeq
  }

  get lastActivityAt(): number | undefined {
    return this.#lastActivityAt
  }

  append(body: SessionEventBody): SessionEvent {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    // An idle timeout putting the engine to sleep is the gateway acting, not the session, and must not reorder lists.
    if (event.type !== 'engine_sleep') {
      this.#lastActivityAt = event.ts
    }
    this.#fold(event)
    this.#retain(event)
    return event
  }

  at(seq: number): SessionEvent | undefined {
    return this.#events.find((event) => event.seq === seq)
  }

  restore(events: readonly SessionEvent[], seq: number, lastActivityAt: number | undefined): void {
    this.#events = []
    this.#seq = seq
    this.#activityCount = 0
    this.#proseCount = 0
    this.#contextUsage = undefined
    this.#checklist = undefined
    this.#statusLabel = undefined
    this.#goal = undefined
    this.#resetSeq = 0
    for (const event of events) {
      this.#fold(event)
      this.#retain(event)
    }
    this.#lastActivityAt = lastActivityAt
  }

  #retain(event: SessionEvent): void {
    const key = logCoalesceKey(event)
    if (key !== undefined) {
      for (let index = this.#events.length - 1; index >= 0; index--) {
        if (logCoalesceKey(this.#events[index]!) === key) {
          this.#events.splice(index, 1)
          break
        }
      }
    }
    this.#events.push(event)
  }

  #fold(event: SessionEvent): void {
    this.#activityCount += transcriptActivity(event)
    this.#proseCount += transcriptProse(event)
    this.#contextUsage = contextReading(event) ?? this.#contextUsage
    if (event.type === 'checklist') {
      this.#checklist = event.items.length > 0 ? event.items : undefined
    }
    if (event.type === 'status_label') {
      this.#statusLabel = event.label
    }
    if (event.type === 'goal_changed') {
      this.#goal = event.goal
    }
    if (event.type === 'conversation_reset') {
      this.#resetSeq = event.seq
      this.#contextUsage = undefined
      this.#checklist = undefined
      this.#statusLabel = null
      this.#goal = null
    }
  }
}
