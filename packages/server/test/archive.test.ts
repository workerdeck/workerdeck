import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ProfileInfo, SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer, type WorkerServer } from '../src/index.ts'
import { archiveEpoch, viewArchive } from '../src/services/archives.ts'
import type { HistoryRead, HistoryReader, HistoryTarget } from '../src/services/history-reader.ts'
import type { ArchivedSessionRecord } from '../src/services/session-store.ts'
import { EngineRunner } from './engine-runner.ts'
import { gatewayFixture } from './helpers.ts'

const HISTORY: SessionEventBody[] = [
  { type: 'user_message', message: { role: 'user', content: 'Remember PELICAN' }, parentToolUseId: null, replay: true, uuid: 'u1' },
  {
    type: 'assistant_message',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
    parentToolUseId: null,
    replay: true,
    uuid: 'a1',
  } as SessionEventBody,
]

function reader(answer: HistoryRead): HistoryReader & { reads: HistoryTarget[] } {
  const reads: HistoryTarget[] = []
  return {
    reads,
    read: async (target) => {
      reads.push(target)
      return answer
    },
  }
}

const profile: ProfileInfo = { name: 'engine', engine: 'provider', provider: { id: 'test', model: 'test-model' } }
const fixture = gatewayFixture('wd-archive-')

afterEach(fixture.cleanup)

async function gateway(dir: string, history: HistoryReader, extra: ProfileInfo[] = []) {
  const built: EngineRunner[] = []
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile, ...extra],
    parking: { store: createFileSessionStore({ dir }), parkDelayMs: 10 },
    historyReader: history,
    createEngineRunner: ({ config, id }) => {
      const runner = new EngineRunner(id ?? `session-${built.length + 1}`, config)
      built.push(runner)
      return runner
    },
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, built, base: `http://127.0.0.1:${port}/v1` }
}

async function createSession(base: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: 'engine' }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

async function archiveLive(server: WorkerServer, id: string): Promise<void> {
  await server.parking.fence(id)
  const record = await server.parking.archiveOf(id, { agentId: 'ag', supersededBy: 'next' })
  await server.parking.saveArchive(record!)
  server.registry.remove(id)
}

async function listIds(base: string): Promise<string[]> {
  return ((await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }).sessions.map((row) => row.id)
}

type Attached = { frames: Array<Record<string, unknown>>; ws: WebSocket; closed: Promise<number> }

async function attach(base: string, id: string, afterSeq = 0, epoch?: unknown): Promise<Attached> {
  const query = `afterSeq=${afterSeq}` + (epoch === undefined ? '' : `&epoch=${String(epoch)}`)
  const ws = new WebSocket(`${base.replace('http', 'ws')}/sessions/${id}/ws?${query}`)
  const frames: Array<Record<string, unknown>> = []
  ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>))
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { frames, ws, closed }
}

describe('archived conversations', () => {
  it('leave the list, stay readable by id, refuse changes, and can be erased', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir, reader({ kind: 'ok', events: HISTORY }))
    const session = await createSession(base)
    await vi.waitFor(() => expect(server.registry.get(session.id)?.info().status).toBe('idle'))

    await archiveLive(server, session.id)

    await vi.waitFor(async () => expect(await listIds(base)).not.toContain(session.id))
    const got = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as { session: SessionInfo }
    expect(got.session).toMatchObject({ archived: true, supersededBy: 'next', status: 'closed' })
    const rename = await fetch(`${base}/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    })
    expect(rename.status).toBe(409)
    expect(((await rename.json()) as { error: string }).error).toBe('conversation is archived')

    expect((await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })).ok).toBe(true)
    expect((await fetch(`${base}/sessions/${session.id}`)).status).toBe(404)
  })

  it('replay from the engine store after a restart without waking anything', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir, reader({ kind: 'ok', events: HISTORY }))
    const session = await createSession(first.base)
    await vi.waitFor(() => expect(first.server.registry.get(session.id)?.info().status).toBe('idle'))
    await archiveLive(first.server, session.id)
    await first.server.parking.flush()
    await first.server.close()
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)

    const history = reader({ kind: 'ok', events: HISTORY })
    const second = await gateway(dir, history)
    expect(await listIds(second.base)).not.toContain(session.id)

    const one = await attach(second.base, session.id)
    await vi.waitFor(() => expect(one.frames.filter((frame) => frame.type === 'event')).toHaveLength(2))
    expect(one.frames[0]).toMatchObject({ type: 'attached', session: { archived: true, lastSeq: 2 } })
    expect(one.frames.filter((frame) => frame.type === 'event').map((frame) => (frame.event as SessionEvent).seq)).toEqual([1, 2])
    expect(history.reads[0]).toMatchObject({ sessionId: session.id, engineSessionId: `engine-${session.id}`, cwd: '/tmp/project' })

    one.ws.send(JSON.stringify({ type: 'user_message', text: 'hi', clientId: 'c1' }))
    await vi.waitFor(() => expect(one.frames.some((frame) => frame.type === 'ack')).toBe(true))
    expect(one.frames.some((frame) => frame.type === 'protocol_error' && frame.message === 'conversation is archived')).toBe(true)
    one.ws.close()

    const epoch = (one.frames[0]!.session as SessionInfo).epoch
    const again = await attach(second.base, session.id, 2, epoch)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(again.frames.filter((frame) => frame.type === 'event')).toHaveLength(0)
    again.ws.close()

    expect(second.built).toHaveLength(0)
  })

  it('carry an epoch of their own: a live cursor gets the whole replay, an archive cursor only newer rows', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir, reader({ kind: 'ok', events: HISTORY }))
    const session = await createSession(base)
    await vi.waitFor(() => expect(server.registry.get(session.id)?.info().status).toBe('idle'))
    const liveEpoch = server.registry.get(session.id)?.info().epoch
    await archiveLive(server, session.id)

    const seqs = (attached: Attached) =>
      attached.frames.filter((frame) => frame.type === 'event').map((frame) => (frame.event as SessionEvent).seq)
    const live = await attach(base, session.id, 800)
    await vi.waitFor(() => expect(seqs(live)).toEqual([1, 2]))
    const epoch = (live.frames[0]!.session as SessionInfo).epoch
    expect(epoch).toBeTypeOf('number')
    expect(epoch).not.toBe(liveEpoch)
    expect(live.frames[0]).toMatchObject({ type: 'attached', replayingFrom: 800, session: { archived: true, lastSeq: 2 } })
    live.ws.close()

    const newer = await attach(base, session.id, 1, epoch)
    await vi.waitFor(() => expect(seqs(newer)).toEqual([2]))
    expect((newer.frames[0]!.session as SessionInfo).epoch).toBe(epoch)
    newer.ws.close()

    const current = await attach(base, session.id, 2, epoch)
    const otherLog = await attach(base, session.id, 2, Number(epoch) + 1)
    await vi.waitFor(() => expect(seqs(otherLog)).toEqual([1, 2]))
    expect(seqs(current)).toEqual([])
    current.ws.close()
    otherLog.ws.close()
  })

  it('mark a transcript the engine no longer has as unavailable, and close on a failed read so the client retries', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir, reader({ kind: 'missing' }))
    const session = await createSession(first.base)
    await vi.waitFor(() => expect(first.server.registry.get(session.id)?.info().status).toBe('idle'))
    await archiveLive(first.server, session.id)

    const gone = await attach(first.base, session.id)
    await vi.waitFor(() => expect(gone.frames[0]).toMatchObject({ type: 'attached', session: { transcript: 'unavailable', lastSeq: 0 } }))
    gone.ws.close()

    await first.server.close()
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)
    const second = await gateway(dir, reader({ kind: 'failed', error: 'timeout' }))
    const failed = await attach(second.base, session.id)
    expect(await failed.closed).toBe(1011)
  })

  it('archive a dormant conversation from its stored record', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir, reader({ kind: 'ok', events: HISTORY }))
    const session = await createSession(first.base)
    await vi.waitFor(async () => expect((await createFileSessionStore({ dir }).get(session.id))?.kind).toBe('dormant'))
    await first.server.close()
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)

    const second = await gateway(dir, reader({ kind: 'ok', events: HISTORY }))
    await second.server.parking.fence(session.id)
    const record = await second.server.parking.archiveOf(session.id, { agentId: 'ag' })
    expect(record).toMatchObject({ kind: 'archived', engineSessionId: `engine-${session.id}`, info: { archived: true, status: 'closed' } })
    await second.server.parking.saveArchive(record!)

    expect(await listIds(second.base)).not.toContain(session.id)
    const view = await attach(second.base, session.id)
    await vi.waitFor(() => expect(view.frames.filter((frame) => frame.type === 'event')).toHaveLength(2))
    view.ws.close()
    expect(second.built).toHaveLength(0)
  })
})

describe('the archived record', () => {
  it("pins the engine home the session's profile resolved to, and none for a profile already gone", async () => {
    const dir = await fixture.stateDir()
    const codexHome = await fixture.stateDir()
    const codex: ProfileInfo = { name: 'codex', engine: 'codex', codexHome }
    const { server } = await gateway(dir, reader({ kind: 'missing' }), [codex])
    const dormant = (id: string, name: string) =>
      createFileSessionStore({ dir }).save({
        kind: 'dormant',
        id,
        info: {
          id,
          status: 'idle',
          cwd: '/tmp/project',
          createdAt: 1,
          lastSeq: 0,
          pendingPermissionCount: 0,
          engine: 'codex',
          profile: name,
          sdkSessionId: `thread-${id}`,
        },
        profile: name,
        config: { cwd: '/tmp/project', profile: name },
        sdkSessionId: `thread-${id}`,
        savedAt: 1,
      })
    await dormant('c-1', 'codex')
    await dormant('c-2', 'gone')
    await server.parking.fence('c-1')
    expect(await server.parking.archiveOf('c-1', {})).toMatchObject({ home: { codexHome }, engineSessionId: 'thread-c-1' })
    await server.parking.fence('c-2')
    expect((await server.parking.archiveOf('c-2', {}))?.home).toBeUndefined()
  })
})

describe('the archive view', () => {
  const base: ArchivedSessionRecord = {
    kind: 'archived',
    id: 'arch-1',
    info: {
      id: 'arch-1',
      status: 'closed',
      cwd: '/tmp/project',
      createdAt: 1,
      lastSeq: 800,
      epoch: 3,
      pendingPermissionCount: 0,
      archived: true,
    },
    config: { cwd: '/tmp/project' },
    engineSessionId: 'sdk-1',
    profile: 'work',
    archivedAt: 5_000,
  }

  it('reports the last seq of a sparse snapshot as its cursor, under the archive epoch', async () => {
    const events = [
      { ...HISTORY[0]!, seq: 3, ts: 1 },
      { ...HISTORY[1]!, seq: 7, ts: 2 },
    ] as SessionEvent[]
    const record: ArchivedSessionRecord = {
      ...base,
      snapshot: { engine: 'provider', id: 'arch-1', createdAt: 1, seq: 9, events, parked: [], state: {} },
    }
    const view = await viewArchive(reader({ kind: 'missing' }), record)
    expect(view.info).toMatchObject({ lastSeq: 7, epoch: archiveEpoch(record) })
    expect(view.events?.map((event) => event.seq)).toEqual([3, 7])
  })

  it('derives an epoch that is stable for the record and never the live one', async () => {
    const history = reader({ kind: 'ok', events: HISTORY })
    const first = await viewArchive(history, base)
    const second = await viewArchive(history, base)
    expect(first.info.epoch).toBe(second.info.epoch)
    expect(first.info.epoch).not.toBe(3)
    expect(archiveEpoch({ ...base, info: { ...base.info, epoch: archiveEpoch(base) } })).not.toBe(archiveEpoch(base))
    expect(archiveEpoch({ ...base, archivedAt: 6_000 })).not.toBe(archiveEpoch(base))
  })

  it('hands the reader the engine home recorded with the archive', async () => {
    const history = reader({ kind: 'ok', events: HISTORY })
    await viewArchive(history, { ...base, home: { claudeConfigDir: '/recorded/claude' } })
    await viewArchive(history, base)
    expect(history.reads[0]).toMatchObject({ profile: 'work', home: { claudeConfigDir: '/recorded/claude' } })
    expect(history.reads[1]?.home).toBeUndefined()
  })
})
