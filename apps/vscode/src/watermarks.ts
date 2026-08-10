import * as vscode from 'vscode'

/**
 * "What had you seen, and when" — per session, across window reloads.
 *
 * Two numbers because two surfaces ask different questions. The sidebar has only
 * the REST rollup for sessions it isn't showing, so it compares **turns**; the
 * panel has the whole transcript, so it compares **rows** and can put the mark
 * in the right place. Keeping both means neither surface has to attach to
 * something it isn't rendering.
 *
 * A watermark is only written while a session is genuinely on screen — the panel
 * visible, showing that session. A dock nobody can see is not being read, and
 * marking it read is how an unread badge silently stops working.
 */
export type Watermark = {
  /** Transcript rows seen (`SessionVitals.itemCount`). */
  itemCount: number
  /** Rows the gateway had counted (`SessionInfo.activityCount`) — the same unit
   * as `itemCount`, but from the rollup, so it is knowable for a session this
   * window is not showing. */
  activity: number
  /** Completed turns seen. The fallback unit for a gateway too old to report
   * `activityCount`; five tool calls in one turn count as one. */
  turns: number
  /** When this was last true. */
  seenAt: number
}

const KEY = 'workerdeck.watermarks.v1'

/** Entries older than this are dropped on write — a session deleted months ago
 * should not keep a row in globalState forever. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class Watermarks {
  readonly #memento: vscode.Memento
  #cache: Record<string, Watermark>

  constructor(context: vscode.ExtensionContext) {
    this.#memento = context.globalState
    this.#cache = { ...context.globalState.get<Record<string, Watermark>>(KEY) }
  }

  get(hostId: string, sessionId: string): Watermark | undefined {
    return this.#cache[key(hostId, sessionId)]
  }

  /**
   * Record what is on screen now. Monotonic on purpose: a transcript that
   * *shrank* (a compaction, a fresh attach mid-replay) must not walk the mark
   * backwards and resurrect rows the user already read.
   */
  mark(
    hostId: string,
    sessionId: string,
    seen: { itemCount?: number; activity?: number; turns?: number },
  ): void {
    const id = key(hostId, sessionId)
    const previous = this.#cache[id]
    const next: Watermark = {
      itemCount: Math.max(previous?.itemCount ?? 0, seen.itemCount ?? 0),
      activity: Math.max(previous?.activity ?? 0, seen.activity ?? 0),
      turns: Math.max(previous?.turns ?? 0, seen.turns ?? 0),
      seenAt: Date.now(),
    }
    if (
      previous &&
      previous.itemCount === next.itemCount &&
      previous.activity === next.activity &&
      previous.turns === next.turns &&
      // Still worth a write once a minute so "last here" stays honest without
      // hammering globalState on every streamed row.
      next.seenAt - previous.seenAt < 60_000
    ) {
      return
    }
    this.#cache[id] = next
    void this.#memento.update(KEY, this.#prune())
  }

  /** Forget a session — it was deleted, and its mark is now noise. */
  forget(hostId: string, sessionId: string): void {
    if (!(key(hostId, sessionId) in this.#cache)) return
    delete this.#cache[key(hostId, sessionId)]
    void this.#memento.update(KEY, this.#cache)
  }

  #prune(): Record<string, Watermark> {
    const cutoff = Date.now() - MAX_AGE_MS
    for (const [id, mark] of Object.entries(this.#cache)) {
      if (mark.seenAt < cutoff) delete this.#cache[id]
    }
    return this.#cache
  }
}

const key = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`
