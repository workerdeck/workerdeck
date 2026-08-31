import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@workerdeck/protocol'
import { attachSeedToken, planAttach, shouldWriteParting } from '../src/lib/attach-plan.ts'
import { initialTranscriptState, seedFromSessionInfo, type TranscriptState } from '../src/lib/transcript.ts'
import { clearTranscriptCache, deleteTranscriptCache, readTranscriptCache, writeTranscriptCache } from '../src/lib/transcript-cache.ts'

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

function held(lastSeq: number): TranscriptState {
  return seedFromSessionInfo({ ...initialTranscriptState, lastSeq }, info({ lastSeq }))
}

const KEY = 'identity s1'

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

describe('attachSeedToken', () => {
  it('changes when the resync counter bumps — the retry must not look already-seeded', () => {
    expect(attachSeedToken(1, KEY)).not.toBe(attachSeedToken(0, KEY))
  })

  it('changes when the key changes — a session switch must re-seed', () => {
    expect(attachSeedToken(0, 'identity s2')).not.toBe(attachSeedToken(0, KEY))
  })
})

describe('planAttach', () => {
  it('holds the reducer state as-is on the mount that seeded it', () => {
    const current = held(7)
    const plan = planAttach(inputs({ current }))
    expect(plan.seed).toBe(false)
    expect(plan.held).toBe(current)
    expect(plan.afterSeq).toBe(7)
    expect(plan.seedToken).toBe(attachSeedToken(0, KEY))
  })

  it('ignores a racing cache write when already seeded — afterSeq derives from the held object, never a second read', () => {
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
    const warm = held(42)
    const plan = planAttach(inputs({ seededFor: attachSeedToken(0, 'identity s0'), current: held(900), warm }))
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(warm)
    expect(plan.afterSeq).toBe(42)
    expect(plan.seedToken).toBe(attachSeedToken(0, KEY))
  })

  it('seeds blank and attaches cold on a switch to an uncached session', () => {
    const plan = planAttach(inputs({ seededFor: attachSeedToken(0, 'identity s0'), current: held(900) }))
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(initialTranscriptState)
    expect(plan.afterSeq).toBeUndefined()
  })

  it('a warm entry that never got past seq 0 still attaches cold', () => {
    const plan = planAttach(inputs({ seededFor: attachSeedToken(0, 'identity s0'), warm: initialTranscriptState }))
    expect(plan.afterSeq).toBeUndefined()
  })

  it('never reads warm state when caching is disabled', () => {
    const plan = planAttach(inputs({ seededFor: attachSeedToken(0, 'identity s0'), cacheEnabled: false, warm: held(42) }))
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(initialTranscriptState)
    expect(plan.afterSeq).toBeUndefined()
  })

  it('the stale-log retry attaches cold, even over a re-written entry', () => {
    const plan = planAttach(inputs({ resyncSeq: 1, current: held(500), skipCache: true, warm: held(500) }))
    expect(plan.seed).toBe(true)
    expect(plan.held).toBe(initialTranscriptState)
    expect(plan.afterSeq).toBeUndefined()
    expect(plan.seedToken).toBe(attachSeedToken(1, KEY))
  })
})

describe('shouldWriteParting', () => {
  it('keeps a real parting transcript warm', () => {
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: false, parting: held(9) })).toBe(true)
  })

  it('refuses when caching is off', () => {
    expect(shouldWriteParting({ cacheEnabled: false, skipCache: false, parting: held(9) })).toBe(false)
  })

  it('refuses the condemned state after a stale-log detection', () => {
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: true, parting: held(500) })).toBe(false)
  })

  it('refuses a mount that never finished attaching, so it cannot clobber a good entry', () => {
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: false, parting: initialTranscriptState })).toBe(false)
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

describe('the attach choreography', () => {
  beforeEach(() => clearTranscriptCache())

  it('detach keeps the transcript warm; the switch-back holds it and asks for exactly the gap', () => {
    const parting = held(9)
    expect(shouldWriteParting({ cacheEnabled: true, skipCache: false, parting })).toBe(true)
    writeTranscriptCache(KEY, parting)
    const current = readTranscriptCache(KEY) ?? initialTranscriptState
    const plan = planAttach(inputs({ current, warm: readTranscriptCache(KEY) }))
    expect(plan.seed).toBe(false)
    expect(plan.held).toBe(parting)
    expect(plan.afterSeq).toBe(9)
  })

  it('the stale-log recovery: the cleanup withholds the condemned state and the retry attaches cold', () => {
    const condemned = held(500)
    writeTranscriptCache(KEY, condemned)
    let skipCache = false
    const first = planAttach(inputs({ current: condemned, skipCache, warm: readTranscriptCache(KEY) }))
    skipCache = false // the effect clears the flag once the plan has consumed it
    expect(first.afterSeq).toBe(500)
    deleteTranscriptCache(KEY)
    skipCache = true
    writeTranscriptCache(KEY, condemned)
    expect(shouldWriteParting({ cacheEnabled: true, skipCache, parting: condemned })).toBe(false)
    const retry = planAttach(inputs({ resyncSeq: 1, current: condemned, skipCache, warm: readTranscriptCache(KEY) }))
    expect(retry.seed).toBe(true)
    expect(retry.held).toBe(initialTranscriptState)
    expect(retry.afterSeq).toBeUndefined()
  })
})
