import {
  contextReading,
  transcriptActivity,
  transcriptProse,
  type ContextReading,
  type SessionEvent,
  type SessionEventBody,
} from '@workerdeck/protocol'

export class EventLog {
  #events: SessionEvent[] = []
  #seq = 0
  #activityCount = 0
  #proseCount = 0
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

  // The unread badge's unit — see `transcriptProse`. Folded here so a restored log recomputes it.
  get proseCount(): number {
    return this.#proseCount
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

  append(body: SessionEventBody): SessionEvent {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#lastActivityAt = event.ts
    this.#fold(event)
    this.#events.push(event)
    return event
  }

  at(seq: number): SessionEvent | undefined {
    return this.#events.find((event) => event.seq === seq)
  }

  restore(events: readonly SessionEvent[], seq: number, lastActivityAt: number | undefined): void {
    this.#events = [...events]
    this.#seq = seq
    this.#activityCount = 0
    this.#proseCount = 0
    this.#contextUsage = undefined
    this.#resetSeq = 0
    for (const event of this.#events) {
      this.#fold(event)
    }
    this.#lastActivityAt = lastActivityAt
  }

  #fold(event: SessionEvent): void {
    this.#activityCount += transcriptActivity(event)
    this.#proseCount += transcriptProse(event)
    this.#contextUsage = contextReading(event) ?? this.#contextUsage
    if (event.type === 'conversation_reset') {
      this.#resetSeq = event.seq
      this.#contextUsage = undefined
    }
  }
}
