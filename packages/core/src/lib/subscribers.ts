/**
 * A subscriber is a listener plus what it asked for; delivery is one method, so
 * which rules reach the live path is stated in exactly one place:
 * `coalesceReplay` is replay-only by construction (live, there is no "later"),
 * `truncateResults` is replay-only by decision (the head budget exceeds both
 * clients' display budgets), and `imageRefs` applies to **both** — the client's
 * one render path is ref-then-fetch. Consumers that subscribe with no options —
 * parking, notifications, the queue — see every byte.
 */
import type { SessionEvent } from '@workerdeck/protocol'
import type { SessionEventListener } from '../runner-interface.ts'
import { refImageParts, replaySlice } from './replay.ts'

/** What a subscriber asked for. Absent fields mean the untransformed stream. */
export type SubscribeOptions = {
  coalesceReplay?: boolean
  truncateResults?: boolean
  imageRefs?: boolean
}

export class SubscriberSet {
  readonly #listeners = new Map<SessionEventListener, SubscribeOptions>()

  /**
   * Replay `events` to `listener` under `options`, then hold it for live
   * delivery. Returns the unsubscribe.
   *
   * The replay runs *before* the listener joins the set, which is the ordering
   * every runner already had and is load-bearing: joining first would deliver a
   * live event emitted mid-replay ahead of the buffered events preceding it.
   */
  subscribe(
    events: readonly SessionEvent[],
    listener: SessionEventListener,
    afterSeq = 0,
    options?: SubscribeOptions,
    resetSeq = 0,
  ): () => void {
    const asked = options ?? {}
    for (const event of replaySlice(events, { ...asked, afterSeq, resetSeq })) {
      listener(event)
    }
    this.#listeners.set(listener, asked)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Drop every subscriber — a park, which ends the session's live stream. */
  clear(): void {
    this.#listeners.clear()
  }

  /** Fan one event out, transformed per subscriber. */
  emit(event: SessionEvent): void {
    for (const [listener, asked] of this.#listeners) {
      try {
        listener(asked.imageRefs ? refImageParts(event) : event)
      } catch {
        // Listener errors must not break the runner loop.
      }
    }
  }
}
