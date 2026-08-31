/**
 * Bounded module-scope LRU of detached `TranscriptState`s, keyed by {@link transcriptCacheKey} —
 * the client's `identityKey` plus the session id, never the session id alone, so no entry is
 * readable through a client speaking as a different principal. Eviction is least-recently-stored.
 * See `docs/PACKAGES.md` §`packages/react` and `docs/GOTCHAS.md` §Attach replay.
 */

import type { WorkerDeckClient } from '@workerdeck/client'
import type { TranscriptState } from './transcript.ts'

/** How many detached transcripts stay warm. Five covers an operator's working
 * set while keeping the pathological case (five ~4k-item transcripts) in the
 * tens of megabytes. Too small degrades to a replay on switch-back; too large
 * is memory held forever in a webview — the asymmetry favours small. */
const MAX_ENTRIES = 5

const entries = new Map<string, TranscriptState>()

/** Cache key for one session as seen through one (gateway, principal). The
 * NUL separator is unambiguous: the identity key is `JSON.stringify` output,
 * which escapes control characters, so no two (identity, session) pairs can
 * spell the same key. */
export const transcriptCacheKey = (client: WorkerDeckClient, sessionId: string): string => `${client.identityKey}\u0000${sessionId}`

export const readTranscriptCache = (key: string): TranscriptState | undefined => entries.get(key)

export const writeTranscriptCache = (key: string, state: TranscriptState): void => {
  entries.delete(key)
  entries.set(key, state)
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) {
      entries.delete(oldest)
    }
  }
}

export const deleteTranscriptCache = (key: string): void => {
  entries.delete(key)
}

/**
 * Drop every cached transcript. For an embedder changing principals in place
 * (a logout that keeps the page alive) — entries are unreachable through the
 * new principal's client either way, but scrubbing them is free and final.
 */
export const clearTranscriptCache = (): void => {
  entries.clear()
}
