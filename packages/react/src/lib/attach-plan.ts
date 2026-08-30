/**
 * The attach effect's decisions, pure. `useClaudeSession` is never rendered in
 * tests — this package deliberately carries no jsdom — so everything the effect
 * decides (which state an attach holds, whether to re-seed the reducer, which
 * `afterSeq` to request, whether the parting state may be cached) is decided
 * here where plain vitest reaches it. The refs stay in the hook: everything
 * stateful arrives as a value and leaves as an instruction.
 */

import { initialTranscriptState, type TranscriptState } from './transcript.ts'

/**
 * Which (resync, client identity, session) a reducer state was seeded for.
 * One format, shared by the hook's mount initializer and {@link planAttach},
 * so the two sites cannot drift: a token that dropped `resyncSeq` would leave
 * the stale-log retry looking already-seeded, and the fresh replay would
 * compose into the condemned state the resync just discarded.
 */
export const attachSeedToken = (resyncSeq: number, key: string): string => `${resyncSeq}:${key}`

/** Everything the decision reads — the hook's refs and options, as values.
 * `warm` is the caller's ONE cache read for this attach; whether it may be
 * used is decided here, and `afterSeq` derives only from what is actually
 * held. */
export type AttachInputs = {
  /** Bumped by the hook after a stale-log detection to force a fresh attach. */
  resyncSeq: number
  /** `transcriptCacheKey(client, sessionId)` — gateway identity + session. */
  key: string
  /** The token the reducer's current state was seeded under (seededForRef). */
  seededFor: string
  /** What the reducer holds right now (stateRef). */
  current: TranscriptState
  /** `options.cacheTranscript !== false`, read at attach time. */
  cacheEnabled: boolean
  /** True between a stale-log detection and its retry (skipCacheRef). */
  skipCache: boolean
  /** The cache entry under `key`, if any. */
  warm: TranscriptState | undefined
}

export type AttachPlan = {
  /** The state this attach composes onto. `afterSeq` was derived from it and
   * from nothing else. */
  held: TranscriptState
  /** True when the reducer must be re-seeded with `held` before any frame can
   * arrive; the effect then records `seedToken` as what it seeded for. */
  seed: boolean
  /** The token `held` belongs to — `attachSeedToken(resyncSeq, key)`. */
  seedToken: string
  /** Attach with `afterSeq` — a warm attach, replaying only the missed span —
   * or, when absent, attach cold from seq 0. */
  afterSeq?: number
}

/** Decide what one run of the attach effect does before it opens the socket. */
export const planAttach = (input: AttachInputs): AttachPlan => {
  const seedToken = attachSeedToken(input.resyncSeq, input.key)
  // The warm entry is admissible only when caching is on and no stale-log
  // detection stands between us and it: after one, the retry must attach cold
  // even if another mount re-wrote the key after the delete — holding that
  // write would re-open the exact silence the resync exists to escape.
  const warm = input.cacheEnabled && !input.skipCache ? input.warm : undefined
  // What the reducer holds for THIS attach. When its state was seeded for this
  // very token (the mount whose initializer read the cache), use it as-is;
  // otherwise seed before any frame arrives — applyEvent's `seq <= lastSeq`
  // dedupe would silently swallow a new session's (or a fresh log's) entire
  // replay into old state.
  const seed = input.seededFor !== seedToken
  const held = seed ? (warm ?? initialTranscriptState) : input.current
  // `afterSeq` comes from the state actually held, never from a second cache
  // read: deriving both from one object keeps a racing write from another
  // mount from opening a gap between what is painted and what replays.
  return { held, seed, seedToken, ...(held.lastSeq > 0 ? { afterSeq: held.lastSeq } : {}) }
}

/**
 * Whether the effect's cleanup may keep the parting transcript warm for a
 * switch-back. Refused when caching is off; after a stale-log detection —
 * writing the condemned state back would re-poison the very retry that just
 * discarded it; and when there is nothing real to keep — `lastSeq === 0` also
 * protects an existing entry from being clobbered by a mount that never
 * finished attaching, and a state with no `session` never saw its attached
 * frame at all.
 */
export const shouldWriteParting = (input: { cacheEnabled: boolean; skipCache: boolean; parting: TranscriptState }): boolean =>
  input.cacheEnabled && !input.skipCache && input.parting.lastSeq > 0 && input.parting.session !== undefined
