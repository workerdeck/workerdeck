export type Watermark = {
  itemCount: number
  activity: number
  turns: number
  seenAt: number
}

export type WatermarkStore = {
  read(): Record<string, Watermark> | undefined
  write(marks: Record<string, Watermark>): void
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const TOUCH_MS = 60_000

export function watermarkKey(hostId: string, sessionId: string) {
  return `${hostId}:${sessionId}`
}

export class Watermarks {
  readonly #store: WatermarkStore
  #cache: Record<string, Watermark>

  constructor(store: WatermarkStore) {
    this.#store = store
    this.#cache = { ...store.read() }
  }

  get(hostId: string, sessionId: string): Watermark | undefined {
    return this.#cache[watermarkKey(hostId, sessionId)]
  }

  all(): Readonly<Record<string, Watermark>> {
    return this.#cache
  }

  mark(hostId: string, sessionId: string, seen: { itemCount?: number; activity?: number; turns?: number }, now = Date.now()): boolean {
    const id = watermarkKey(hostId, sessionId)
    const previous = this.#cache[id]
    const next: Watermark = {
      itemCount: Math.max(previous?.itemCount ?? 0, seen.itemCount ?? 0),
      activity: Math.max(previous?.activity ?? 0, seen.activity ?? 0),
      turns: Math.max(previous?.turns ?? 0, seen.turns ?? 0),
      seenAt: now,
    }
    if (
      previous &&
      previous.itemCount === next.itemCount &&
      previous.activity === next.activity &&
      previous.turns === next.turns &&
      next.seenAt - previous.seenAt < TOUCH_MS
    ) {
      return false
    }
    this.#cache[id] = next
    this.#store.write(this.#prune(now))
    return true
  }

  forget(hostId: string, sessionId: string): void {
    const id = watermarkKey(hostId, sessionId)
    if (!(id in this.#cache)) {
      return
    }
    delete this.#cache[id]
    this.#store.write(this.#cache)
  }

  #prune(now: number): Record<string, Watermark> {
    const cutoff = now - MAX_AGE_MS
    for (const [id, mark] of Object.entries(this.#cache)) {
      if (mark.seenAt < cutoff) {
        delete this.#cache[id]
      }
    }
    return this.#cache
  }
}

export function unseenCount(mark: Watermark | undefined, info: { activityCount?: number; turns?: number }): number {
  if (!mark) {
    return 0
  }
  if (info.activityCount !== undefined) {
    return Math.max(0, info.activityCount - mark.activity)
  }
  return Math.max(0, (info.turns ?? 0) - mark.turns)
}
