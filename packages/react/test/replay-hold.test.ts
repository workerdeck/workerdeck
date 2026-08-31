import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import { WorkerDeckClient, type SessionHandle } from '@workerdeck/client'
import type { AttachedFrame, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { initialReplayTarget } from '../src/hooks/use-session.ts'

function frame(replayingFrom: number, lastSeq: number): AttachedFrame {
  const session: SessionInfo = {
    id: 's1',
    status: 'idle',
    cwd: '/tmp/project',
    createdAt: Date.now(),
    lastSeq,
    pendingPermissionCount: 0,
  }
  return { type: 'attached', protocolVersion: 7, session, replayingFrom }
}

describe('initialReplayTarget', () => {
  it('holds a fresh attach until the replay lands', () => {
    expect(initialReplayTarget(frame(0, 42))).toBe(42)
  })

  it('never holds a brand-new session (nothing to replay)', () => {
    expect(initialReplayTarget(frame(0, 0))).toBeUndefined()
  })

  it('never holds a reconnect — the reader is already looking at the transcript', () => {
    expect(initialReplayTarget(frame(17, 42))).toBeUndefined()
    expect(initialReplayTarget(frame(1, 900))).toBeUndefined()
  })
})

function idleQueryFn() {
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

async function start() {
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

describe('the attach replay signal, over the wire', () => {
  it('sends attached before any event, and the replay reaches session.lastSeq', async () => {
    const client = await start()
    const session = await client.createSession({ cwd: '/tmp/project' })

    const writer = client.attach(session.id)
    handles.push(writer)
    await new Promise<void>((resolve) => writer.on('attached', () => resolve()))
    writer.send('one')
    writer.send('two')
    writer.send('three')
    await vi.waitFor(async () => {
      const info = await client.getSession(session.id)
      expect(info.lastSeq).toBeGreaterThanOrEqual(3)
    })
    const settled = await client.getSession(session.id)

    const kinds: Array<'attached' | 'event'> = []
    const events: SessionEvent[] = []
    let attached: AttachedFrame | undefined
    const reader = client.attach(session.id)
    handles.push(reader)
    reader.on('attached', (f: AttachedFrame) => {
      kinds.push('attached')
      attached = f
    })
    reader.on('event', (e: SessionEvent) => {
      kinds.push('event')
      events.push(e)
    })
    await vi.waitFor(() => {
      expect(attached).toBeDefined()
      expect(events.at(-1)?.seq ?? 0).toBeGreaterThanOrEqual(attached!.session.lastSeq)
    })

    expect(kinds[0]).toBe('attached')
    expect(attached!.replayingFrom).toBe(0)
    expect(attached!.session.lastSeq).toBeGreaterThanOrEqual(settled.lastSeq)
    expect(initialReplayTarget(attached!)).toBe(attached!.session.lastSeq)
    const seqs = events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

    const reattach = client.attach(session.id, { afterSeq: attached!.session.lastSeq })
    handles.push(reattach)
    const refreshed = await new Promise<AttachedFrame>((resolve) => reattach.on('attached', (f: AttachedFrame) => resolve(f)))
    expect(refreshed.replayingFrom).toBe(attached!.session.lastSeq)
    expect(initialReplayTarget(refreshed)).toBeUndefined()
  }, 15_000)
})
