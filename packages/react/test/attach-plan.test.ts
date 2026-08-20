import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@workerdeck/protocol'
import { attachSeedToken, planAttach, shouldWriteParting } from '../src/lib/attach-plan.ts'
import {
  initialTranscriptState,
  seedFromSessionInfo,
  type TranscriptState,
} from '../src/lib/transcript.ts'
import {
  clearTranscriptCache,
  deleteTranscriptCache,
  readTranscriptCache,
  writeTranscriptCache,
} from '../src/lib/transcript-cache.ts'

/**
 * The attach effect's decision seam. `useClaudeSession` is never rendered in
 * tests (no jsdom in this package, by design), so the logic that used to be
 * tangled into its attach effect — seed-or-hold, warm-read gating, `afterSeq`,
 * the stale-log retry, the parting write-back — is pinned here against the
 * pure functions the effect now merely applies. The wire facts these
 * decisions rest on (a warm attach replays exactly the gap; a stale afterSeq
 * delivers nothing) are pinned in transcript-cache.test.ts, and the reducer
 * the seed feeds is pinned in transcript.test.ts.
 */

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    status: 'idle',
    cwd: '/tmp/project',
    createdAt: 1_000,
    lastSeq: 0,
    pendingPermissionCount: 0,
    ...overrides,
  }
}

/** A transcript that attached and saw events up to `lastSeq`. */
function held(lastSeq: number): TranscriptState {
  return seedFromSessionInfo({ ...initialTranscriptState, lastSeq }, info({ lastSeq }))
}

const KEY = 'identity s1'

/** The plan inputs for one healthy, cache-on attach; tests override the part
 * whose decision they pin. */
function inputs(overrides: Partial<Parameters<typeof planAttach>[0]> = {}) {
  return {
    resyncSeq: 0,
    key: KEY,
    seededFor: attachSeedToken(0, KEY),
    current: initialTranscriptState,
    cacheEnabled: true,
    skipCache: false,
    warm: undefined,
    ...overrides,
  }
}

// -- The seed token -----------------------------------------------------------

describe('attachSeedToken', () => {
  it('changes when the resync counter bumps — the retry must not look already-seeded', () => {
    expect(attachSeedToken(1, KEY)).not.toBe(attachSeedToken(0, KEY))
  })

  it('changes when the key changes — a session switch must re-seed', () => {
    expect(attachSeedToken(0, 'identity s2')).not.toBe(attachSeedToken(0, KEY))
  })
})

// -- planAttach: seed or hold -------------------------------------------------

describe('planAttach', () => {
  it('holds the reducer state as-is on the mount that seeded it', () => {
    // The mount initializer already read the cache into the reducer and marked
    // its token; re-seeding here would be a wasted dispatch, not a bug — the
    // bug would be deriving afterSeq from anything else.
    const current = held(7)
    const plan = planAttach(inputs({ current }))
    expect(plan.seed).toBe(false)
    expect(plan.held).toBe(current)
    expect(plan.afterSeq).toBe(7)
    expect(plan.seedToken).toBe(attachSeedToken(0, KEY))
  })

  it('ignores a racing cache write when already seeded — afterSeq derives from the held object, never a second read', () => {
    // Another mount of the same session advanced the entry to seq 50 while
    // this one was planning. Holding OUR state and asking after OUR seq keeps
    // paint and replay derived from one object; taking the entry's 50 against
    // a transcript painted at 7 would open a 43-event gap with no error.
    const current = held(7)
    const plan = planAttach(inputs({ current, warm: held(50) }))
    expect(plan.held).toBe(current)
    expect(plan.afterSeq).toBe(7)
  })

  it('a mount that seeded blank attaches cold', () => {
    const plan = planAttach(inputs({ current: initialTranscriptState }))
    expect(plan.seed).toBe(false)
    expect(plan.afterSeq).toBeUndefined()
  })

  it('seeds from the warm entry on an in-place session switch', () => {
    // Same hook instance, sessionId prop changed: the reducer still holds the
    // OLD session. Without the re-seed, applyEvent's `seq <= lastSeq` dedupe
    // would silently swallow the new session's entire replay — every replayed
    // seq can sit below the old transcript's lastSeq.
    const warm = held(42)
    const plan = planAttach(
      inputs({ seededFor: attachSeedToken(0, 'identity s0'), current: held(900), warm }),
    )
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(warm)
    expect(plan.afterSeq).toBe(42)
    expect(plan.seedToken).toBe(attachSeedToken(0, KEY))
  })

  it('seeds blank and attaches cold on a switch to an uncached session', () => {
    const plan = planAttach(
      inputs({ seededFor: attachSeedToken(0, 'identity s0'), current: held(900) }),
    )
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(initialTranscriptState)
    expect(plan.afterSeq).toBeUndefined()
  })

  it('a warm entry that never got past seq 0 still attaches cold', () => {
    const plan = planAttach(
      inputs({ seededFor: attachSeedToken(0, 'identity s0'), warm: initialTranscriptState }),
    )
    expect(plan.afterSeq).toBeUndefined()
  })

  it('never reads warm state when caching is disabled', () => {
    // cacheTranscript: false is the embedder whose principal varies invisibly
    // on one base URL — a warm entry under this key may be another user's.
    const plan = planAttach(
      inputs({ seededFor: attachSeedToken(0, 'identity s0'), cacheEnabled: false, warm: held(42) }),
    )
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(initialTranscriptState)
    expect(plan.afterSeq).toBeUndefined()
  })

  it('the stale-log retry attaches cold, even over a re-written entry', () => {
    // After a stale-log detection the hook deleted the entry, set skipCache and
    // bumped resyncSeq — and another mount raced a write back in. The retry
    // must be blind to it: attaching with no afterSeq is what makes
    // staleAttach false by definition, so the recovery cannot loop.
    const plan = planAttach(
      inputs({ resyncSeq: 1, current: held(500), skipCache: true, warm: held(500) }),
    )
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(initialTranscriptState)
    expect(plan.afterSeq).toBeUndefined()
    expect(plan.seedToken).toBe(attachSeedToken(1, KEY))
  })
})

// -- The parting write-back ---------------------------------------------------

describe('shouldWriteParting', () => {
  it('keeps a real parting transcript warm', () => {
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: false, parting: held(9) })).toBe(
      true,
    )
  })

  it('refuses when caching is off', () => {
    expect(shouldWriteParting({ cacheEnabled: false, skipCache: false, parting: held(9) })).toBe(
      false,
    )
  })

  it('refuses the condemned state after a stale-log detection', () => {
    // Writing it back would re-poison the very retry that just discarded it.
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: true, parting: held(500) })).toBe(
      false,
    )
  })

  it('refuses a mount that never finished attaching, so it cannot clobber a good entry', () => {
    expect(
      shouldWriteParting({ cacheEnabled: true, skipCache: false, parting: initialTranscriptState }),
    ).toBe(false)
  })

  it('refuses a state that never saw its attached frame', () => {
    expect(
      shouldWriteParting({
        cacheEnabled: true,
        skipCache: false,
        parting: { ...initialTranscriptState, lastSeq: 3 },
      }),
    ).toBe(false)
  })
})

// -- The choreography over the real store -------------------------------------

describe('the attach choreography', () => {
  beforeEach(() => clearTranscriptCache())

  it('detach keeps the transcript warm; the switch-back holds it and asks for exactly the gap', () => {
    // Unmount: the cleanup's write-back.
    const parting = held(9)
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: false, parting })).toBe(true)
    writeTranscriptCache(KEY, parting)
    // Remount: the initializer reads the entry into the reducer and marks its
    // token, so the plan holds that same object and attaches with afterSeq —
    // the wire replays only what landed while the panel was away.
    const current = readTranscriptCache(KEY) ?? initialTranscriptState
    const plan = planAttach(inputs({ current, warm: readTranscriptCache(KEY) }))
    expect(plan.seed).toBe(false)
    expect(plan.held).toBe(parting)
    expect(plan.afterSeq).toBe(9)
  })

  it('the stale-log recovery: the cleanup withholds the condemned state and the retry attaches cold', () => {
    // The poisoned start: a cached transcript from a log the server no longer
    // has (a dormant rebuild started a fresh runner at seq 0).
    const condemned = held(500)
    writeTranscriptCache(KEY, condemned)
    // Mount: initializer read the entry, so the first plan asks after seq 500 —
    // the attach that will go silent and trip staleAttach on its frame.
    let skipCache = false
    const first = planAttach(
      inputs({ current: condemned, skipCache, warm: readTranscriptCache(KEY) }),
    )
    skipCache = false // the effect clears the flag once the plan has consumed it
    expect(first.afterSeq).toBe(500)
    // The frame flags stale: the hook deletes the entry, sets skipCache, bumps
    // resyncSeq — and another mount races a write back in before the retry.
    deleteTranscriptCache(KEY)
    skipCache = true
    writeTranscriptCache(KEY, condemned)
    // The condemned effect's cleanup runs first, and must not write back.
    expect(shouldWriteParting({ cacheEnabled: true, skipCache, parting: condemned })).toBe(false)
    // The retry: the bumped token forces the re-seed, skipCache blinds it to
    // the raced write, and no afterSeq means staleAttach is false by
    // definition — the recovery cannot loop.
    const retry = planAttach(
      inputs({ resyncSeq: 1, current: condemned, skipCache, warm: readTranscriptCache(KEY) }),
    )
    expect(retry.seed).toBe(true)
    expect(retry.held).toBe(initialTranscriptState)
    expect(retry.afterSeq).toBeUndefined()
  })
})
