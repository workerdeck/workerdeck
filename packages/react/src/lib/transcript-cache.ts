import type { WorkerDeckClient } from '@workerdeck/client'
import type { TranscriptState } from './transcript.ts'

/**
 * Module-scope cache of detached transcript states, so switching back to a
 * recently viewed session paints its transcript in the mount frame and
 * re-attaches with `afterSeq: lastSeq` — the wire replays only what happened
 * while the panel was away, instead of the whole event log.
 *
 * Module-scope for the same reason `useSessions` and the watermarks are: the
 * consumers that need it (the VS Code panel, the dashboard's session route)
 * remount `SessionPanel` per session, so any per-hook copy would die with the
 * unmount that is the entire point of surviving.
 *
 * Entries are the same `TranscriptState` objects the reducer held — retention,
 * not duplication — and the bound is what keeps retention from becoming a
 * leak. Eviction is least-recently-STORED: every detach stores, so store
 * recency is viewing recency, and reads don't need to reorder.
 *
 * Keys come from {@link transcriptCacheKey} and carry the client's
 * `identityKey` (gateway + auth headers), never the session id alone: a
 * session id is unique only within one gateway, and an entry must never be
 * readable through a client speaking as a different principal.
 */

/**
 * How many detached transcripts stay warm.
 *
 * Five covers the working set the feature exists for — an operator alternating
 * between the handful of sessions that are simultaneously working or awaiting
 * them — while keeping the pathological case (five `perf`-fixture-sized
 * transcripts of ~4k items each) in the tens of megabytes, no more than a few
 * times what the one mounted panel already holds. Too small degrades to
 * today's behaviour (a replay on switch-back); too large is memory held
 * forever in a webview — the asymmetry favours small.
 */
const MAX_ENTRIES = 5

const entries = new Map<string, TranscriptState>()

/** Cache key for one session as seen through one (gateway, principal). The
 * NUL separator is unambiguous: the identity key is `JSON.stringify` output,
 * which escapes control characters, so no two (identity, session) pairs can
 * spell the same key. */
export function transcriptCacheKey(client: WorkerDeckClient, sessionId: string): string {
  return `${client.identityKey}\u0000${sessionId}`
}

export function readTranscriptCache(key: string): TranscriptState | undefined {
  return entries.get(key)
}

export function writeTranscriptCache(key: string, state: TranscriptState): void {
  entries.delete(key)
  entries.set(key, state)
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) {
      entries.delete(oldest)
    }
  }
}

export function deleteTranscriptCache(key: string): void {
  entries.delete(key)
}

/**
 * Drop every cached transcript. For an embedder changing principals in place
 * (a logout that keeps the page alive) — entries are unreachable through the
 * new principal's client either way, but scrubbing them is free and final.
 */
export function clearTranscriptCache(): void {
  entries.clear()
}
