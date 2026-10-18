import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInfo, AgentResponse, ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import {
  createFileAgentStore,
  createFileSessionStore,
  createWorkerServer,
  type WorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import type { RunnerSnapshot } from '@workerdeck/core'
import type { AgentStore, StoredAgent } from '../src/services/agent-store.ts'
import type { SessionStore } from '../src/services/session-store.ts'
import { EngineRunner } from './engine-runner.ts'
import { gatewayFixture } from './helpers.ts'

const profile: ProfileInfo = { name: 'engine', engine: 'provider', provider: { id: 'test', model: 'test-model' } }
const fixture = gatewayFixture('wd-handover-safety-')
afterEach(fixture.cleanup)

type Hooks = {
  building?: (runner: EngineRunner) => void | Promise<void>
  agentStore?: AgentStore
  options?: Partial<WorkerServerOptions>
}

async function gateway(dir: string, hooks: Hooks = {}) {
  const built: EngineRunner[] = []
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile],
    parking: { store: createFileSessionStore({ dir: join(dir, 'sessions') }), parkDelayMs: 10 },
    agentStore: hooks.agentStore ?? createFileAgentStore(join(dir, 'agents.json')),
    historyReader: { read: async () => ({ kind: 'missing' }) },
    agentStartupTimeoutMs: 100,
    createEngineRunner: async ({ config, id }) => {
      const runner = new EngineRunner(id ?? `session-${built.length + 1}`, config)
      built.push(runner)
      await hooks.building?.(runner)
      return runner
    },
    ...hooks.options,
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, built, base: `http://127.0.0.1:${port}/v1` }
}

async function call(base: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function createAgent(base: string, name: string, lead?: string): Promise<AgentResponse> {
  const res = await call(base, '/agents', 'POST', { name, config: { cwd: '/tmp/project', profile: 'engine' }, prompt: 'work', lead })
  expect(res.status).toBe(201)
  return (await res.json()) as AgentResponse
}

async function agentOf(base: string, id: string): Promise<AgentInfo> {
  return ((await (await call(base, `/agents/${id}`)).json()) as AgentResponse).agent
}

async function sessionOf(base: string, id: string): Promise<SessionInfo> {
  return ((await (await call(base, `/sessions/${id}`)).json()) as { session: SessionInfo }).session
}

async function idle(server: WorkerServer, id: string): Promise<void> {
  await vi.waitFor(() => expect(server.registry.get(id)?.info().status).toBe('idle'))
}

function stored(dir: string, id: string): StoredAgent {
  return (createFileAgentStore(join(dir, 'agents.json')).list() as StoredAgent[]).find((agent) => agent.id === id)!
}

async function stop(server: WorkerServer): Promise<void> {
  await server.parking.flush()
  await server.close()
  fixture.servers.splice(fixture.servers.indexOf(server), 1)
}

class SnapshotRunner extends EngineRunner {
  override info(): SessionInfo {
    const info = super.info()
    return { ...info, capabilities: { ...info.capabilities!, resume: false, resumeBackfill: false } }
  }

  snapshot(): RunnerSnapshot {
    return { engine: 'provider', id: this.id, createdAt: this.createdAt, seq: this.info().lastSeq, events: [], parked: [], state: null }
  }
}

function held(): { gate: Promise<void>; open: () => void } {
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  return { gate, open }
}

describe('handover: the successor is durable before the intent goes', () => {
  it('keeps the intent while the new conversation is still starting, and clears it once its record is saved', async () => {
    const dir = await fixture.stateDir()
    let hold: Promise<void> | undefined
    const { server, base } = await gateway(dir, { building: (runner) => void (runner.hold = hold) })
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    const start = held()
    hold = start.gate

    const res = await call(base, `/agents/${agent.id}/restart`, 'POST', { prompt: 'continue' })
    expect(res.status).toBe(200)
    const fresh = ((await res.json()) as AgentResponse).session!.id
    expect(stored(dir, agent.id).pending).toMatchObject({ to: fresh, promptState: 'sent' })
    expect(await server.parking.get(fresh)).toBeNull()

    start.open()
    await vi.waitFor(() => expect(stored(dir, agent.id).pending).toBeUndefined())
    expect((await server.parking.get(fresh))?.kind).toBe('dormant')
  })

  it('reports a failed start, refuses another rotation, and retries the same conversation without resending', async () => {
    const dir = await fixture.stateDir()
    let failing: string | undefined
    const { server, base, built } = await gateway(dir, { building: (runner) => void (runner.failStart = failing) })
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    failing = 'engine refused'

    const res = await call(base, `/agents/${agent.id}/restart`, 'POST', { prompt: 'continue' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('engine refused')
    const pending = stored(dir, agent.id).pending!
    expect(pending.startError).toBe('engine refused')
    expect((await call(base, `/agents/${agent.id}/restart`, 'POST', {})).status).toBe(409)
    const listed = (await (await call(base, '/agents', 'GET')).json()) as { agents: AgentInfo[] }
    expect(listed.agents.find((entry) => entry.id === agent.id)?.startFailed).toBe('engine refused')

    failing = undefined
    const retried = await call(base, `/agents/${agent.id}/retry-start`, 'POST', {})
    expect(retried.status).toBe(200)
    const body = (await retried.json()) as AgentResponse
    expect(body.session!.id).toBe(pending.to)
    expect(body.agent.undelivered).toBe('continue')
    expect(body.agent.startFailed).toBeUndefined()
    expect(built.filter((runner) => runner.id === pending.to).at(-1)!.sent).toEqual([])
    expect(stored(dir, agent.id).pending).toBeUndefined()
  })

  it('recovers onto a successor that already has a record: no fresh conversation, and an uncertain message is kept', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const { agent, session } = await createAgent(first.base, 'Wren')
    await idle(first.server, session!.id)
    const rotated = (await (await call(first.base, `/agents/${agent.id}/restart`, 'POST', { prompt: 'continue' })).json()) as AgentResponse
    const fresh = rotated.session!.id
    await stop(first.server)

    createFileAgentStore(join(dir, 'agents.json')).save({
      ...stored(dir, agent.id),
      pending: { op: 'rotate', from: session!.id, to: fresh, prompt: 'continue', promptState: 'sending', startedAt: 1 },
    })
    const second = await gateway(dir)
    expect(second.built.some((runner) => runner.id === fresh)).toBe(false)
    expect(stored(dir, agent.id).pending).toBeUndefined()
    expect((await agentOf(second.base, agent.id)).undelivered).toBe('continue')
    expect((await second.server.parking.get(fresh))?.kind).toBe('dormant')
  })
})

describe('handover: the successor record is read back, not assumed', () => {
  it('keeps the intent with a start error when the new record cannot be saved, and Retry start saves it', async () => {
    const dir = await fixture.stateDir()
    const inner = createFileSessionStore({ dir: join(dir, 'sessions') })
    let broken = false
    const store: SessionStore = {
      ...inner,
      get: (id) => inner.get(id),
      list: () => inner.list(),
      delete: (id) => inner.delete(id),
      save: async (record) => {
        if (broken && record.kind !== 'archived') {
          throw new Error('disk full')
        }
        await inner.save(record)
      },
    }
    const { server, base } = await gateway(dir, { options: { parking: { store, parkDelayMs: 10 } } })
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    broken = true

    const res = await call(base, `/agents/${agent.id}/restart`, 'POST', { prompt: 'continue' })
    expect(res.status).toBe(502)
    const pending = stored(dir, agent.id).pending!
    expect(pending.startError).toBe('the new conversation could not be saved')
    expect(await server.parking.get(pending.to!)).toBeNull()

    broken = false
    expect((await call(base, `/agents/${agent.id}/retry-start`, 'POST', {})).status).toBe(200)
    expect(stored(dir, agent.id).pending).toBeUndefined()
    expect((await server.parking.get(pending.to!))?.kind).toBe('dormant')
  })

  it('reads back the live snapshot of an engine without resume before the intent goes', async () => {
    const dir = await fixture.stateDir()
    const inner = createFileSessionStore({ dir: join(dir, 'sessions') })
    let broken = false
    const store: SessionStore = {
      ...inner,
      get: (id) => inner.get(id),
      list: () => inner.list(),
      delete: (id) => inner.delete(id),
      save: async (record) => {
        if (broken && record.kind !== 'archived') {
          throw new Error('disk full')
        }
        await inner.save(record)
      },
    }
    const built: SnapshotRunner[] = []
    const server = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [profile],
      parking: { store, parkDelayMs: 10, persistLive: true },
      agentStore: createFileAgentStore(join(dir, 'agents.json')),
      historyReader: { read: async () => ({ kind: 'missing' }) },
      createEngineRunner: ({ config, id }) => {
        const runner = new SnapshotRunner(id ?? `session-${built.length + 1}`, config)
        built.push(runner)
        return runner
      },
    })
    fixture.servers.push(server)
    const base = `http://127.0.0.1:${(await server.listen(0, '127.0.0.1')).port}/v1`
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)

    broken = true
    expect((await call(base, `/agents/${agent.id}/restart`, 'POST', {})).status).toBe(502)
    const pending = stored(dir, agent.id).pending!
    expect(pending.startError).toBe('the new conversation could not be saved')
    broken = false
    expect((await call(base, `/agents/${agent.id}/retry-start`, 'POST', {})).status).toBe(200)
    expect(stored(dir, agent.id).pending).toBeUndefined()
    expect((await server.parking.get(pending.to!))?.kind).toBe('live')
  })

  it('keeps an idle successor that has no engine conversation yet recoverable until its first message saves one', async () => {
    const dir = await fixture.stateDir()
    const nameless = (runner: EngineRunner) => void (runner.nameless = true)
    const first = await gateway(dir, { building: nameless })
    const { agent, session } = await createAgent(first.base, 'Wren')
    await idle(first.server, session!.id)

    const res = await call(first.base, `/agents/${agent.id}/restart`, 'POST', {})
    expect(res.status).toBe(200)
    const fresh = ((await res.json()) as AgentResponse).session!.id
    expect(stored(dir, agent.id).pending).toMatchObject({ to: fresh, awaiting: true })
    expect(await first.server.parking.get(fresh)).toBeNull()
    await stop(first.server)

    const second = await gateway(dir, { building: nameless })
    const revived = second.built.find((runner) => runner.id === fresh)
    expect(revived).toBeDefined()
    expect(stored(dir, agent.id).pending).toMatchObject({ to: fresh, awaiting: true })
    await idle(second.server, fresh)
    revived!.sendMessage('hello')
    await vi.waitFor(() => expect(stored(dir, agent.id).pending).toBeUndefined())
    expect((await second.server.parking.get(fresh))?.kind).toBe('dormant')
    expect((await agentOf(second.base, agent.id)).sessionId).toBe(fresh)
  })

  it('lets a new conversation replace one that is still waiting for its first message', async () => {
    const { server, base } = await gateway(await fixture.stateDir(), { building: (runner) => void (runner.nameless = true) })
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    const once = (await (await call(base, `/agents/${agent.id}/restart`, 'POST', {})).json()) as AgentResponse
    await idle(server, once.session!.id)
    const twice = await call(base, `/agents/${agent.id}/restart`, 'POST', {})
    expect(twice.status).toBe(200)
    expect((await agentOf(base, agent.id)).sessionId).toBe(((await twice.json()) as AgentResponse).session!.id)
  })
})

describe('handover: fencing, commit failure, members, stale callers', () => {
  it('never lets a wake that was already under way register the conversation being archived', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const { agent, session } = await createAgent(first.base, 'Wren')
    await idle(first.server, session!.id)
    await stop(first.server)

    const rebuild = held()
    const second = await gateway(dir, { building: (runner) => (runner.config.resume ? rebuild.gate : undefined) })
    const wake = second.server.parking.ensureLive(session!.id)
    await vi.waitFor(() => expect(second.built.some((runner) => runner.id === session!.id)).toBe(true))
    const rotation = call(second.base, `/agents/${agent.id}/restart`, 'POST', {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    rebuild.open()

    expect(await wake).toBeUndefined()
    expect((await rotation).status).toBe(200)
    expect(second.server.registry.get(session!.id)).toBeUndefined()
    expect(await second.server.parking.ensureLive(session!.id)).toBeUndefined()
    expect((await sessionOf(second.base, session!.id)).archived).toBe(true)
  })

  it('leaves the old conversation usable when the commit write throws', async () => {
    const dir = await fixture.stateDir()
    const inner = createFileAgentStore(join(dir, 'agents.json'))
    let broken = false
    const agentStore: AgentStore = {
      list: () => inner.list(),
      save: (agent) => {
        if (broken) {
          throw new Error('disk full')
        }
        return inner.save(agent)
      },
      delete: (id) => inner.delete(id),
    }
    const { server, base } = await gateway(dir, { agentStore })
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    broken = true
    expect((await call(base, `/agents/${agent.id}/restart`, 'POST', {})).status).toBe(500)
    broken = false
    expect((await call(base, `/sessions/${session!.id}`, 'PATCH', { title: 'still mine' })).status).toBe(200)
    expect(server.parking.fenced(session!.id)).toBe(false)
  })

  it('archives every member a lead takes with it', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createAgent(base, 'Lead')
    const member = await createAgent(base, 'Member', lead.agent.id)
    await idle(server, member.session!.id)

    const res = await call(base, `/agents/${lead.agent.id}`, 'DELETE', { members: 'retire' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { retired: string[] }).retired.sort()).toEqual([lead.agent.id, member.agent.id].sort())
    for (const id of [lead.session!.id, member.session!.id]) {
      expect((await sessionOf(base, id)).archived).toBe(true)
    }
    expect(((await (await call(base, '/sessions')).json()) as { sessions: SessionInfo[] }).sessions).toEqual([])
    expect(stored(dir, member.agent.id)).toMatchObject({ retiredAt: expect.any(Number) })
    expect(stored(dir, member.agent.id).pending).toBeUndefined()
  })

  it('never turns two restarts from an older client into two rotations', async () => {
    const { server, base } = await gateway(await fixture.stateDir())
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    const [one, two] = await Promise.all([
      call(base, `/agents/${agent.id}/restart`, 'POST', {}),
      call(base, `/agents/${agent.id}/restart`, 'POST', {}),
    ])
    expect([one.status, two.status].sort()).toEqual([200, 409])
    expect((await agentOf(base, agent.id)).conversations).toHaveLength(2)
  })

  it('sends an undelivered first message once, however many confirmations race', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const { agent, session } = await createAgent(first.base, 'Wren')
    await idle(first.server, session!.id)
    await stop(first.server)
    createFileAgentStore(join(dir, 'agents.json')).save({
      ...stored(dir, agent.id),
      sessionId: 'next-1',
      pending: { op: 'rotate', from: session!.id, to: 'next-1', prompt: 'resume', promptState: 'sending', startedAt: 1 },
    })

    const second = await gateway(dir)
    const answers = await Promise.all([
      call(second.base, `/agents/${agent.id}/undelivered`, 'POST', { send: true }),
      call(second.base, `/agents/${agent.id}/undelivered`, 'POST', { send: true }),
    ])
    expect(answers.map((res) => res.status).sort()).toEqual([200, 404])
    expect(second.built.find((runner) => runner.id === 'next-1')!.sent).toEqual(['resume'])
  })
})

describe('archive erase', () => {
  it('is operator-only even for a caller allowed to read the archive', async () => {
    const { server, base } = await gateway(await fixture.stateDir(), {
      options: {
        allowUnauthenticated: false,
        authenticate: (req) => (req.headers.authorization === 'Bearer op' ? { operator: true } : { operator: false }),
        authorizeSession: () => true,
      },
    })
    const op = { authorization: 'Bearer op' }
    const created = await call(base, '/agents', 'POST', { name: 'Wren', config: { cwd: '/tmp/project', profile: 'engine' } }, op)
    const { agent, session } = (await created.json()) as AgentResponse
    await idle(server, session!.id)
    expect((await call(base, `/agents/${agent.id}/restart`, 'POST', {}, op)).status).toBe(200)

    const user = { authorization: 'Bearer user' }
    expect((await call(base, `/sessions/${session!.id}`, 'GET', undefined, user)).status).toBe(200)
    expect((await call(base, `/sessions/${session!.id}`, 'DELETE', undefined, user)).status).toBe(403)
    expect((await call(base, `/sessions/${session!.id}`, 'GET', undefined, op)).status).toBe(200)
  })
})
