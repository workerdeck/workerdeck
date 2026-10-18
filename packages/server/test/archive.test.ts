import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ProfileInfo, SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer, type WorkerServer } from '../src/index.ts'
import type { HistoryRead, HistoryReader, HistoryTarget } from '../src/services/history-reader.ts'
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

async function gateway(dir: string, history: HistoryReader) {
  const built: EngineRunner[] = []
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile],
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

async function attach(base: string, id: string, afterSeq = 0): Promise<Attached> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/sessions/${id}/ws?afterSeq=${afterSeq}`)
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

    const again = await attach(second.base, session.id, 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(again.frames.filter((frame) => frame.type === 'event')).toHaveLength(0)
    again.ws.close()

    expect(second.built).toHaveLength(0)
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
