import type { SessionEvent } from '@workerdeck/protocol'
import type { SessionEventListener } from '../runner-interface.ts'
import { refImageParts, replaySlice } from './replay.ts'

export type SubscribeOptions = {
  coalesceReplay?: boolean
  truncateResults?: boolean
  imageRefs?: boolean
}

export class SubscriberSet {
  readonly #listeners = new Map<SessionEventListener, SubscribeOptions>()

  // The replay runs before the listener joins the set: joining first would deliver a live
  // event emitted mid-replay ahead of the buffered events preceding it.
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

  clear(): void {
    this.#listeners.clear()
  }

  emit(event: SessionEvent): void {
    for (const [listener, asked] of this.#listeners) {
      try {
        listener(asked.imageRefs ? refImageParts(event) : event)
      } catch {}
    }
  }
}
