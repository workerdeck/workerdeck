export type Watermark = {
  itemCount: number
  activity: number
  /**
   * Prose rows read (`SessionInfo.proseCount`). Optional because a mark stored before
   * prose counting existed cannot say — see `unseenCount`, which reads that absence as
   * "caught up" rather than badging a whole history the operator has already seen.
   */
  prose?: number
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

  mark(
    hostId: string,
    sessionId: string,
    seen: { itemCount?: number; activity?: number; prose?: number; turns?: number },
    now = Date.now(),
  ): boolean {
    const id = watermarkKey(hostId, sessionId)
    const previous = this.#cache[id]
    const next: Watermark = {
      itemCount: Math.max(previous?.itemCount ?? 0, seen.itemCount ?? 0),
      activity: Math.max(previous?.activity ?? 0, seen.activity ?? 0),
      // A caller with nothing to say about prose (an older gateway reports no `proseCount`)
      // must not overwrite a real mark with 0, which would re-badge everything already read.
      prose: seen.prose === undefined ? previous?.prose : Math.max(previous?.prose ?? 0, seen.prose),
      turns: Math.max(previous?.turns ?? 0, seen.turns ?? 0),
      seenAt: now,
    }
    if (
      previous &&
      previous.itemCount === next.itemCount &&
      previous.activity === next.activity &&
      previous.prose === next.prose &&
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

/**
 * The badge's number, in the best unit the pair can agree on: prose the human has not
 * read, else rows, else turns. The ladder is what keeps an older gateway (no `proseCount`
 * on the wire) badging exactly as it did before rather than going silent.
 */
export function unseenCount(mark: Watermark | undefined, info: { proseCount?: number; activityCount?: number; turns?: number }): number {
  if (!mark) {
    return 0
  }
  if (info.proseCount !== undefined) {
    // `mark.prose` absent = a mark written before prose counting. Reading it as
    // "caught up" costs one missed badge on a session already visited; reading it as 0
    // would badge every such session with its entire history the first time it polls.
    return Math.max(0, info.proseCount - (mark.prose ?? info.proseCount))
  }
  if (info.activityCount !== undefined) {
    return Math.max(0, info.activityCount - mark.activity)
  }
  return Math.max(0, (info.turns ?? 0) - mark.turns)
}
