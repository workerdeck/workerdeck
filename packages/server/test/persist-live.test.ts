import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ProfileInfo, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer, type SessionStore, type WorkerServer } from '../src/index.ts'
import { ParkableRunner } from './parkable-runner.ts'

/**
 * Write-through persistence: the restart story for the engine dormancy cannot
 * cover.
 *
 * A claude or codex session is remembered by *engine session id* and resumed
 * from the engine's own store. A provider session has no such store — the
 * history lives in the runner — so its record carries the state itself, taken
 * with `snapshot()` after each turn and rebuilt through the ordinary `restore`
 * path. What is under test here is the server's half: when it writes, what it
 * writes, that it does not double-list, and above all that a wake does **not**
 * consume the record.
 *
 * `dormant.test.ts` is the sibling for the other mechanism, and this file
 * follows its shape deliberately.
 */

const profile = (name: string): ProfileInfo => ({
  name,
  engine: 'provider',
  provider: { id: 'test', model: 'test-model' },
})

type Gateway = {
  server: WorkerServer
  base: string
  built: ParkableRunner[]
}

const servers: WorkerServer[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/** Start a gateway over `store`. Calling it twice with the same store is the
 * restart this whole feature is about. */
const startGateway = async (store: SessionStore, persistLive = true): Promise<Gateway> => {
  const built: ParkableRunner[] = []
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile('agent')],
    parking: { store, parkDelayMs: 10, persistLive },
    createEngineRunner: ({ config, id, restore }) => {
      const runner = new ParkableRunner(id ?? `session-${built.length + 1}`, config, restore)
      built.push(runner)
      return runner
    },
  })
  servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, base: `http://127.0.0.1:${port}/v1`, built }
}

const create = async (base: string, scope?: Record<string, string>): Promise<SessionInfo> => {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: 'agent', scope }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

const list = async (base: string): Promise<SessionInfo[]> =>
  ((await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }).sessions

const stateDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'wd-live-'))
  dirs.push(dir)
  return dir
}

/** Attach and stay attached, collecting events. The caller closes it. */
const openSocket = async (base: string, id: string): Promise<{ socket: WebSocket; events: SessionEvent[] }> => {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/sessions/${id}/ws`)
  const events: SessionEvent[] = []
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as { type: string; event?: SessionEvent }
    if (frame.type === 'event' && frame.event) {
      events.push(frame.event)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  return { socket, events }
}

/** Attach and collect the replayed log, the way a returning client does. */
const attach = async (base: string, id: string): Promise<SessionEvent[]> => {
  const url = `${base.replace('http', 'ws')}/sessions/${id}/ws`
  const socket = new WebSocket(url)
  const events: SessionEvent[] = []
  // Registered before the open handshake resolves, not after: the replay is sent
  // the moment the socket opens, and a listener attached in the `open` callback
  // misses all of it.
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as { type: string; event?: SessionEvent }
    if (frame.type === 'event' && frame.event) {
      events.push(frame.event)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  // The replay arrives in bursts; a short quiet window is enough to have it all.
  await new Promise((resolve) => setTimeout(resolve, 150))
  socket.close()
  return events
}

describe('live sessions that survive a restart', () => {
  it('writes a live record at the end of a turn, and does not double-list it', async () => {
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store)
    const session = await create(gateway.base)
    gateway.built[0]!.turn('hello', 'hi there')

    await vi.waitFor(async () => {
      expect((await store.get(session.id))?.kind).toBe('live')
    })
    // The registry owns it while it is live — the record is the way back, not a
    // second row.
    const rows = await list(gateway.base)
    expect(rows.filter((row) => row.id === session.id)).toHaveLength(1)
  })

  it('writes nothing at all when the option is off', async () => {
    // A library must not start writing a session's transcript to disk because
    // someone upgraded.
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store, false)
    const session = await create(gateway.base)
    gateway.built[0]!.turn('hello', 'hi there')

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await store.get(session.id)).toBeNull()
  })

  it('records the session as idle whatever it was doing at the time', async () => {
    // A record comes back to a process that is not running the session, so the
    // status it carries has to be what will be *true* then, not what was true
    // when it was written: `running` would list as a spinner over nothing.
    //
    // Driven through the reachable case rather than the obvious one. A session
    // parked on deferred work stays live while a client is attached (`#park`
    // defers to the socket), so the write-through is its only durable record —
    // and `model_changed` is a trigger that fires when the session is anything
    // but idle.
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store)
    const session = await create(gateway.base)
    const runner = gateway.built[0]!
    runner.turn('hello', 'hi')
    // The attached client is the whole premise: without one, `#park` wins the
    // `status_changed: 'parked'` and this is a park, not a live record.
    const client = await openSocket(gateway.base, session.id)
    runner.defer('exec-1')
    expect(runner.info().status).toBe('parked')
    runner.changeModel('other-model')

    await vi.waitFor(async () => {
      const record = await store.get(session.id)
      expect(record?.kind).toBe('live')
      expect(record?.info.status).toBe('idle')
    })
    // …and what it *is* waiting on still rides along, so a restart can re-arm
    // the watchdogs rather than losing the execution.
    const record = await store.get(session.id)
    expect(record && 'executions' in record ? record.executions : []).toHaveLength(1)
    client.socket.close()
  })

  it('brings the whole session back after a restart: transcript, history, files, scope', async () => {
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base, { user: 'ada' })
    first.built[0]!.writeFile('/out/notes.md', 'kept across the restart')
    first.built[0]!.turn('what is the plan', 'the plan is this')

    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })

    // The restart. A close is not a session end: the record stays.
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    // Listed while still dormant on disk — nothing was respawned at boot.
    expect((await list(second.base)).map((row) => row.id)).toContain(session.id)
    expect(second.built).toHaveLength(0)

    // …and rebuilt lazily, on the attach.
    const replayed = await attach(second.base, session.id)
    expect(second.built).toHaveLength(1)
    const runner = second.built[0]!
    expect(runner.id).toBe(session.id)

    // The three things the user would notice were gone.
    expect(runner.messages).toEqual(['user:what is the plan', 'assistant:the plan is this'])
    expect(runner.vfs.read('/out/notes.md')).toBe('kept across the restart')
    expect(runner.info().scope).toEqual({ user: 'ada' })
    // The transcript replays as one unbroken stream, not a fresh session.
    const texts = replayed.filter((event) => event.type === 'assistant_message')
    expect(texts.length).toBeGreaterThan(0)
    expect(replayed.every((event) => event.seq > 0)).toBe(true)
  })

  it('keeps the record on wake — consuming it would lose a session nobody typed into', async () => {
    // The one place a live record must behave differently from a park, and the
    // reason the kinds exist. Consuming it opens a window from the attach to the
    // next turn in which the session is nowhere durable: open it, read it, type
    // nothing, get redeployed, and it is gone with no error and no trace.
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base)
    first.built[0]!.turn('hello', 'hi')
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    await attach(second.base, session.id)
    // Woken, read, and nothing typed — the record must still be there.
    expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()

    // And a second restart still finds it.
    await second.server.close()
    servers.splice(servers.indexOf(second.server), 1)
    const third = await startGateway(createFileSessionStore({ dir }))
    expect((await list(third.base)).map((row) => row.id)).toContain(session.id)
  })

  it('forgets a session that actually ended', async () => {
    const dir = await stateDir()
    const gateway = await startGateway(createFileSessionStore({ dir }))
    const session = await create(gateway.base)
    gateway.built[0]!.turn('hello', 'hi')
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })

    await fetch(`${gateway.base}/sessions/${session.id}`, { method: 'DELETE' })
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).toBeNull()
    })
  })

  it('carries a rename across the restart', async () => {
    // `#configs` holds the config the session was BUILT from and a rename never
    // reaches it — the same trap the dormant record documents. Without taking
    // `meta` from the live info, the rename survives the listing and dies on the
    // wake.
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base)
    first.built[0]!.turn('hello', 'hi')
    await fetch(`${first.base}/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed by hand' }),
    })

    await vi.waitFor(async () => {
      const record = await createFileSessionStore({ dir }).get(session.id)
      expect(record?.info.title).toBe('renamed by hand')
    })
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    const row = (await list(second.base)).find((r) => r.id === session.id)
    expect(row?.title).toBe('renamed by hand')
    await attach(second.base, session.id)
    expect(second.built[0]!.info().meta?.title).toBe('renamed by hand')
  })
})
