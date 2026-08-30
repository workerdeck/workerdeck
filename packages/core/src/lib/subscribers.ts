/**
 * The other half of `replaySlice`, and the same argument.
 *
 * Three runners had a byte-identical `subscribe` body — replay the buffer, add
 * to a `Set`, return a deleter — and a byte-identical fan-out loop beside it,
 * try/catch comment included. `replaySlice` retired the first half of that
 * duplication when the replay grew rules worth stating once. This retires the
 * second, and it is not merely tidiness: the moment a rule applies to **live**
 * events as well as replayed ones, a bare `Set<listener>` has nowhere to keep
 * the options that rule is conditioned on, and each runner would grow its own
 * copy of the answer.
 *
 * So a subscriber is a listener *plus what it asked for*, and delivery is one
 * method. Not a base class, for `replaySlice`'s reason: the runners share
 * nothing else, and a base class would have to own `#emit`, the most
 * engine-specific method each of them has.
 *
 * **Which rules reach the live path is the whole judgement here**, and there is
 * exactly one:
 *
 * - `coalesceReplay` — replay-only by construction. It drops readings superseded
 *   *later in the same replay*; live, there is no later.
 * - `truncateResults` — replay-only by decision. `TOOL_RESULT_HEAD_CHARS` is set
 *   above both clients' own display budgets, so a result arriving while you
 *   watch is already fully on screen and truncating it would buy a fetch for
 *   nothing.
 * - `imageRefs` — **both**. The client's one render path is ref-then-fetch, so
 *   bytes on a live event would either be discarded (335 KB median, once per
 *   attached watcher) or need a second decode-from-event path — which pins
 *   megabytes of base64 inside `TranscriptState`, which the transcript LRU then
 *   retains across session switches. That is the disease relocated, not cured.
 *
 * Consumers that subscribe with no options — parking, notifications, the queue —
 * see every byte, as they do for every other rule in this family.
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
