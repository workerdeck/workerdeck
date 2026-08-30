import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import { WorkerDeckClient, type SessionHandle } from '@workerdeck/client'
import type { AttachedFrame, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { initialReplayTarget, staleAttach } from '../src/hooks/use-session.ts'
import { applyEvent, initialTranscriptState, seedFromSessionInfo, type TranscriptState } from '../src/lib/transcript.ts'
import {
  clearTranscriptCache,
  deleteTranscriptCache,
  readTranscriptCache,
  transcriptCacheKey,
  writeTranscriptCache,
} from '../src/lib/transcript-cache.ts'

/**
 * The transcript cache: a detached session's state is kept warm so a
 * switch-back paints instantly and re-attaches with `afterSeq`. The unit tests
 * pin the store's bound and keying and the staleness rule; the wire tests pin
 * the two facts the whole design rests on — a warm attach replays exactly the
 * missed span and composes to the same transcript a full replay builds, and a
 * stale `afterSeq` against a different log delivers *nothing* (the silent
 * failure `staleAttach` exists to catch).
 */

const info = (overrides: Partial<SessionInfo> = {}): SessionInfo => {
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

const frame = (replayingFrom: number, session: SessionInfo): AttachedFrame => {
  return { type: 'attached', protocolVersion: 7, session, replayingFrom }
}

const held = (lastSeq: number, createdAt = 1_000): TranscriptState => {
  return seedFromSessionInfo({ ...initialTranscriptState, lastSeq }, info({ createdAt, lastSeq }))
}

// -- staleAttach --------------------------------------------------------------

describe('staleAttach', () => {
  it('is never stale on a full replay — resetting and applying it heals everything', () => {
    expect(staleAttach(frame(0, info({ lastSeq: 12 })), held(500))).toBe(false)
  })

  it('is never stale when nothing is held', () => {
    expect(staleAttach(frame(500, info({ lastSeq: 12 })), initialTranscriptState)).toBe(false)
  })

  it('flags a server log shorter than the held transcript', () => {
    // The dormant-rebuild shape: fresh log at 12 events, cached afterSeq 500.
    expect(staleAttach(frame(500, info({ lastSeq: 12 })), held(500))).toBe(true)
  })

  it('flags a rebuilt runner that already advanced past the held seq', () => {
    // Backfill outran the cache: lastSeq 900 ≥ 500, but a new incarnation.
    expect(staleAttach(frame(500, info({ lastSeq: 900, createdAt: 2_000 })), held(500))).toBe(true)
  })

  it('accepts the same log grown longer (the warm switch-back)', () => {
    expect(staleAttach(frame(500, info({ lastSeq: 900 })), held(500))).toBe(false)
  })

  it('accepts a warm attach with nothing missed', () => {
    expect(staleAttach(frame(500, info({ lastSeq: 500 })), held(500))).toBe(false)
  })
})

// -- The store ----------------------------------------------------------------

describe('transcript cache store', () => {
  beforeEach(() => clearTranscriptCache())

  it('keys by (gateway, principal, session), not by client instance', () => {
    const a1 = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'X-Key': 'k' } })
    const a2 = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'x-key': 'k' } })
    const b = new WorkerDeckClient({ baseUrl: 'http://two/v1', headers: { 'X-Key': 'k' } })
    const c = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'X-Key': 'other' } })
    // Two INSTANCES of the same identity share entries — a rebuilt client (a
    // useMemo recreating it on a gateway switch) must still hit.
    expect(transcriptCacheKey(a1, 's1')).toBe(transcriptCacheKey(a2, 's1'))
    // Another gateway, another principal, another session: all distinct.
    expect(transcriptCacheKey(a1, 's1')).not.toBe(transcriptCacheKey(b, 's1'))
    expect(transcriptCacheKey(a1, 's1')).not.toBe(transcriptCacheKey(c, 's1'))
    expect(transcriptCacheKey(a1, 's1')).not.toBe(transcriptCacheKey(a1, 's2'))
  })

  it('bounds retention and evicts the least recently stored', () => {
    for (let i = 0; i < 6; i++) {
      writeTranscriptCache(`k${i}`, { ...initialTranscriptState, lastSeq: i + 1 })
    }
    // Six writes into a bound of five: the first entry is gone, the rest live.
    expect(readTranscriptCache('k0')).toBeUndefined()
    expect(readTranscriptCache('k1')?.lastSeq).toBe(2)
    expect(readTranscriptCache('k5')?.lastSeq).toBe(6)
    // Re-storing an old key refreshes its recency: k1 survives the next write.
    writeTranscriptCache('k1', { ...initialTranscriptState, lastSeq: 99 })
    writeTranscriptCache('k6', { ...initialTranscriptState, lastSeq: 7 })
    expect(readTranscriptCache('k1')?.lastSeq).toBe(99)
    expect(readTranscriptCache('k2')).toBeUndefined()
  })

  it('deletes and clears', () => {
    writeTranscriptCache('k', { ...initialTranscriptState, lastSeq: 1 })
    deleteTranscriptCache('k')
    expect(readTranscriptCache('k')).toBeUndefined()
    writeTranscriptCache('k', { ...initialTranscriptState, lastSeq: 1 })
    clearTranscriptCache()
    expect(readTranscriptCache('k')).toBeUndefined()
  })
})

// -- conversation_reset over a cached state -----------------------------------

describe('a reset replayed above the cached afterSeq', () => {
  it('clears the cached rows and appends the fresh conversation', () => {
    // Cached at seq 500 with two rows; while detached, /clear landed at 520 and
    // one new message at 521. The runner replays both (its skip is strictly
    // below the reset), and the reducer must clear the cached items before
    // appending — the two filters compose.
    let state: TranscriptState = {
      ...held(500),
      items: [
        { kind: 'user', id: 'u-old', text: 'before the clear' },
        { kind: 'assistant_text', id: 'a-old', text: 'old answer', streaming: false, parentToolUseId: null },
      ],
    }
    const replay: SessionEvent[] = [
      { type: 'conversation_reset', seq: 520, ts: 0 },
      {
        type: 'user_message',
        message: { role: 'user', content: 'after the clear' },
        parentToolUseId: null,
        uuid: 'u-new',
        seq: 521,
        ts: 0,
      },
    ]
    for (const event of replay) {
      state = applyEvent(state, event)
    }
    expect(state.items).toEqual([{ kind: 'user', id: 'u-new', text: 'after the clear' }])
    expect(state.lastSeq).toBe(521)
  })
})

// -- The wire facts the cache rests on ----------------------------------------

const idleQueryFn = () => {
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => new Promise<never>(() => {}),
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  }
  return (() => query) as never
}

let running: WorkerServer | undefined
let handles: SessionHandle[] = []

afterEach(async () => {
  for (const handle of handles) {
    handle.detach()
  }
  handles = []
  await running?.close()
  running = undefined
})

const start = async () => {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: idleQueryFn() }),
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return new WorkerDeckClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  })
}

/** Run one attach the way the hook does: seed, then frames into the reducer. */
const reduceAttach = (
  client: WorkerDeckClient,
  sessionId: string,
  seed: TranscriptState,
  afterSeq: number,
): { handle: SessionHandle; frames: AttachedFrame[]; events: SessionEvent[]; state: () => TranscriptState } => {
  let state = seed
  const frames: AttachedFrame[] = []
  const events: SessionEvent[] = []
  const handle = client.attach(sessionId, afterSeq > 0 ? { afterSeq } : {})
  handles.push(handle)
  handle.on('attached', (frame: AttachedFrame) => {
    frames.push(frame)
    state = seedFromSessionInfo(state, frame.session)
  })
  handle.on('event', (event: SessionEvent) => {
    events.push(event)
    state = applyEvent(state, event)
  })
  return { handle, frames, events, state: () => state }
}

describe('warm attach over the wire', () => {
  it('replays only the missed span and composes to the full-replay transcript', async () => {
    const client = await start()
    const session = await client.createSession({ cwd: '/tmp/project' })

    // First visit: full replay into a fresh reducer, then "unmount".
    const writer = client.attach(session.id)
    handles.push(writer)
    await new Promise<void>((resolve) => writer.on('attached', () => resolve()))
    writer.send('one')
    writer.send('two')
    const first = reduceAttach(client, session.id, initialTranscriptState, 0)
    await vi.waitFor(() => {
      expect(first.frames.length).toBe(1)
      expect(first.state().lastSeq).toBeGreaterThanOrEqual(first.frames[0].session.lastSeq)
    })
    first.handle.detach()
    const cached = first.state()
    expect(cached.items.length).toBeGreaterThanOrEqual(2)

    // Two more messages land while "detached".
    writer.send('three')
    writer.send('four')
    await vi.waitFor(async () => {
      const now = await client.getSession(session.id)
      expect(now.lastSeq).toBeGreaterThan(cached.lastSeq)
    })

    // The warm switch-back: attach with afterSeq = cached.lastSeq.
    const warm = reduceAttach(client, session.id, cached, cached.lastSeq)
    await vi.waitFor(() => {
      expect(warm.frames.length).toBe(1)
      expect(warm.state().lastSeq).toBeGreaterThanOrEqual(warm.frames[0].session.lastSeq)
    })
    const warmFrame = warm.frames[0]
    // Not stale, and no hold: the cached rows stay painted while the span lands.
    expect(staleAttach(warmFrame, cached)).toBe(false)
    expect(warmFrame.replayingFrom).toBe(cached.lastSeq)
    expect(initialReplayTarget(warmFrame)).toBeUndefined()
    // The wire got smaller: every replayed event is strictly above afterSeq.
    expect(warm.events.length).toBeGreaterThan(0)
    for (const event of warm.events) {
      expect(event.seq).toBeGreaterThan(cached.lastSeq)
    }

    // Equivalence: the composed state matches what a full replay builds.
    const full = reduceAttach(client, session.id, initialTranscriptState, 0)
    await vi.waitFor(() => {
      expect(full.frames.length).toBe(1)
      expect(full.state().lastSeq).toBeGreaterThanOrEqual(warm.state().lastSeq)
    })
    expect(warm.state().items).toEqual(full.state().items)
    expect(warm.state().status).toBe(full.state().status)
  }, 15_000)

  it('a stale afterSeq delivers nothing — and staleAttach catches it', async () => {
    const client = await start()
    // "Another log": a fresh session standing in for a dormant rebuild that
    // reset the log this client cached seq 500 of.
    const session = await client.createSession({ cwd: '/tmp/project' })
    const writer = client.attach(session.id)
    handles.push(writer)
    await new Promise<void>((resolve) => writer.on('attached', () => resolve()))
    writer.send('hello')
    await vi.waitFor(async () => {
      const now = await client.getSession(session.id)
      expect(now.lastSeq).toBeGreaterThanOrEqual(1)
    })

    const cached = held(500)
    const stale = reduceAttach(client, session.id, cached, cached.lastSeq)
    await vi.waitFor(() => expect(stale.frames.length).toBe(1))
    // The premise: every event in the new log has seq ≤ afterSeq, so the
    // attach is silent — no error, no frames, the stale transcript would just
    // stand. Give the replay ample time to prove nothing is coming.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(stale.events.length).toBe(0)
    // The detection, and the recovery it prescribes: re-attach from zero.
    expect(staleAttach(stale.frames[0], cached)).toBe(true)
    stale.handle.detach()
    const recovered = reduceAttach(client, session.id, initialTranscriptState, 0)
    await vi.waitFor(() => {
      expect(recovered.frames.length).toBe(1)
      expect(recovered.state().lastSeq).toBeGreaterThanOrEqual(recovered.frames[0].session.lastSeq)
    })
    expect(staleAttach(recovered.frames[0], initialTranscriptState)).toBe(false)
    expect(recovered.state().items.length).toBeGreaterThanOrEqual(1)
  }, 15_000)
})
