/**
 * "What had you seen, and when" — per session, across reloads.
 *
 * Two units because two surfaces ask different questions: a list compares rows
 * the *gateway* counted, a panel compares rows it *rendered*, and keeping both
 * means neither has to attach to something it isn't rendering.
 *
 * **A watermark is only written while a session is genuinely on screen** — a
 * surface nobody can see is not being read, and marking it read is how an unread
 * badge silently stops working. Storage is a seam (`WatermarkStore`), not a
 * dependency: `globalState` in the extension, `localStorage` in the dashboard.
 */
export type Watermark = {
  /** Transcript rows seen (`SessionVitals.itemCount`). */
  itemCount: number
  /** Rows the gateway had counted (`SessionInfo.activityCount`) — the same unit
   * as `itemCount`, but from the rollup, so it is knowable for a session this
   * client is not showing. */
  activity: number
  /** Completed turns seen. The fallback unit for a gateway too old to report
   * `activityCount`; five tool calls in one turn count as one. */
  turns: number
  /** When this was last true. */
  seenAt: number
}

/** Where the marks are kept. Reads happen once at construction; writes are
 * whole-map and may be async — nothing here awaits them. */
export type WatermarkStore = {
  read(): Record<string, Watermark> | undefined
  write(marks: Record<string, Watermark>): void
}

/** Entries older than this are dropped on write — a session deleted months ago
 * should not keep a row in storage forever. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** How stale "last here" is allowed to get before a write happens anyway. */
const TOUCH_MS = 60_000

export const watermarkKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`

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

  /** Every mark, for a caller deriving unread counts over a whole list. */
  all(): Readonly<Record<string, Watermark>> {
    return this.#cache
  }

  /**
   * Record what is on screen now. Monotonic on purpose: a transcript that
   * *shrank* (a compaction, a fresh attach mid-replay) must not walk the mark
   * backwards and resurrect rows the user already read.
   *
   * Returns whether the mark actually moved, because an unread badge is computed
   * from it and nothing else will say so: rows read in a panel do not touch the
   * sessions poll, so a caller that doesn't hear about this has no other way to
   * learn the count is now wrong.
   */
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
      // Still worth a write once a minute so "last here" stays honest without
      // hammering storage on every streamed row.
      next.seenAt - previous.seenAt < TOUCH_MS
    ) {
      return false
    }
    this.#cache[id] = next
    this.#store.write(this.#prune(now))
    return true
  }

  /** Forget a session — it was deleted, and its mark is now noise. */
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
 * Rows this client has not seen, from the rollup alone.
 *
 * `activityCount` is the unit that makes an honest badge: turns undercount badly
 * (five tool calls in one turn is one turn) and a stream sequence overcounts
 * absurdly (every delta). Turns stay the fallback for a gateway too old to
 * report it.
 *
 * A session never visited returns 0 — "never opened" is not "unread", and a
 * badge that counted every session's whole history on first launch would be
 * noise on the one day it should be quiet.
 */
export const unseenCount = (mark: Watermark | undefined, info: { activityCount?: number; turns?: number }): number => {
  if (!mark) {
    return 0
  }
  if (info.activityCount !== undefined) {
    return Math.max(0, info.activityCount - mark.activity)
  }
  return Math.max(0, (info.turns ?? 0) - mark.turns)
}
