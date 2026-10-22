// `activity` and `prose` are lifetime counts for the session id, so they only ever grow across a cut. `itemCount`
// is a transcript position inside one conversation, so it belongs to `conversation` and means nothing in another.
export type Watermark = {
  itemCount: number
  conversation?: number
  activity: number
  prose: number
  seenAt: number
}

export type WatermarkReading = { itemCount?: number; conversation?: number; activity?: number; prose?: number }

export type CatchUpFrom = { itemCount: number; since: number; conversation?: number }

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
    // A stored mark of another shape is dropped: its session reads as caught up until the next visit marks it.
    this.#cache = Object.fromEntries(Object.entries(store.read() ?? {}).filter(([, mark]) => typeof mark?.prose === 'number'))
  }

  get(hostId: string, sessionId: string): Watermark | undefined {
    return this.#cache[watermarkKey(hostId, sessionId)]
  }

  all(): Readonly<Record<string, Watermark>> {
    return this.#cache
  }

  mark(
    hostId: string,
    sessionId: string,
    seen: WatermarkReading,
    now = Date.now(),
  ): boolean {
    const id = watermarkKey(hostId, sessionId)
    const previous = this.#cache[id]
    const items = markedItems(previous, seen)
    const next: Watermark = {
      itemCount: items.itemCount,
      ...(items.conversation === undefined ? {} : { conversation: items.conversation }),
      activity: Math.max(previous?.activity ?? 0, seen.activity ?? 0),
      prose: Math.max(previous?.prose ?? 0, seen.prose ?? 0),
      seenAt: now,
    }
    if (
      previous &&
      previous.itemCount === next.itemCount &&
      previous.conversation === next.conversation &&
      previous.activity === next.activity &&
      previous.prose === next.prose &&
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

// A newer conversation's reading replaces the item count, an older one's (a late mark from a view that has not seen the
// cut yet) never raises it, and only a reading of the same conversation takes the max.
function markedItems(previous: Watermark | undefined, seen: WatermarkReading): { itemCount: number; conversation?: number } {
  const held = { itemCount: previous?.itemCount ?? 0, conversation: previous?.conversation }
  if (seen.itemCount === undefined) {
    return held
  }
  if (!previous) {
    return { itemCount: seen.itemCount, conversation: seen.conversation }
  }
  if (seen.conversation === held.conversation) {
    return { itemCount: Math.max(held.itemCount, seen.itemCount), conversation: held.conversation }
  }
  if (seen.conversation !== undefined && (held.conversation === undefined || seen.conversation > held.conversation)) {
    return { itemCount: seen.itemCount, conversation: seen.conversation }
  }
  return held
}

// The mark as a catch-up start: the panel applies `catchUpItems` once it knows which conversation it shows.
export function catchUpFrom(mark: Watermark | undefined): CatchUpFrom | undefined {
  if (!mark) {
    return undefined
  }
  return { itemCount: mark.itemCount, since: mark.seenAt, ...(mark.conversation === undefined ? {} : { conversation: mark.conversation }) }
}

// A mark taken in another conversation is no position in this one, so the recap covers it from the top.
export function catchUpItems(mark: { itemCount: number; conversation?: number }, conversation: number | undefined): number {
  if (mark.conversation === undefined || conversation === undefined || mark.conversation === conversation) {
    return mark.itemCount
  }
  return 0
}

export function unseenCount(mark: Watermark | undefined, info: { proseCount?: number }): number {
  if (!mark || info.proseCount === undefined) {
    return 0
  }
  return Math.max(0, info.proseCount - mark.prose)
}
