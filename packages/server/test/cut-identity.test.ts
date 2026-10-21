import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EngineAdapter, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type AgentInfo, type ProfileEngine, type ProfileInfo, type SessionInfo } from '@workerdeck/protocol'
import {
  createFileAgentStore,
  createFileSessionRecordStore,
  createWorkerServer,
  type WorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import type { StoredAgent } from '../src/services/agent-store.ts'
import { EngineRunner } from './engine-runner.ts'
import { frameCollector, gatewayFixture } from './helpers.ts'

const CLAUDE_HOME = '/tmp/wd-cut-identity-claude'
const CODEX_HOME = '/tmp/wd-cut-identity-codex'

const PROFILES: ProfileInfo[] = [
  { name: 'claude-a', engine: 'claude', configDir: CLAUDE_HOME },
  { name: 'claude-bob', engine: 'claude', configDir: CLAUDE_HOME, owner: 'bob' },
  { name: 'codex-b', engine: 'codex', codexHome: CODEX_HOME },
]

const PRINCIPALS: Record<string, unknown> = {
  operator: { operator: true },
  alice: { owner: 'alice' },
  bob: { owner: 'bob' },
}

const fixture = gatewayFixture('wd-cut-identity-')
beforeAll(() => {
  mkdirSync(CLAUDE_HOME, { recursive: true })
  mkdirSync(CODEX_HOME, { recursive: true })
})
afterEach(fixture.cleanup)

// Carries its owner and job meta the way the real runners do, and offers context_reset when the gateway wired it.
class Engine extends EngineRunner {
  #owner: string | undefined

  constructor(
    id: string,
    config: SessionRunnerConfig,
    readonly engine: ProfileEngine,
  ) {
    super(id, config)
    this.#owner = config.owner
  }

  override info(): SessionInfo {
    return {
      ...super.info(),
      engine: this.engine,
      capabilities: { ...ENGINE_CAPABILITIES[this.engine], resume: true, resumeBackfill: true },
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.permissionMode ? { permissionMode: this.config.permissionMode } : {}),
      ...(this.#owner ? { owner: this.#owner } : {}),
      ...(this.config.meta ? { meta: this.config.meta } : {}),
      ...(this.config.contextReset ? { agentContextReset: true as const } : {}),
    }
  }

  setOwner(owner: string | undefined): void {
    this.#owner = owner
  }

  answer(): void {
    this.emit({ type: 'turn_result', subtype: 'success', isError: false, numTurns: 1, durationMs: 1, totalCostUsd: 0 } as never)
  }
}

type Hooks = {
  building?: (runner: Engine) => void
  options?: Partial<WorkerServerOptions>
  owners?: boolean
  owner?: string
  profiles?: ProfileInfo[]
  diagnostics?: unknown[]
}

async function gateway(dir: string, hooks: Hooks = {}) {
  const built: Engine[] = []
  const adapter = (engine: ProfileEngine): EngineAdapter => ({
    engine,
    capabilities: ENGINE_CAPABILITIES[engine],
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => {
      const runner = new Engine(id ?? `s${built.length + 1}-${dir.slice(-6)}`, config, engine)
      built.push(runner)
      hooks.building?.(runner)
      return runner
    },
  })
  const server: WorkerServer = createWorkerServer({
    ...(hooks.owners
      ? {
          ...('owner' in hooks ? (hooks.owner === undefined ? {} : { owner: hooks.owner }) : { owner: 'alice' }),
          authenticate: (req) => PRINCIPALS[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
          authorizeSession: (principal, session) =>
            (principal as { operator?: boolean }).operator === true || session.owner === (principal as { owner?: string }).owner,
        }
      : { allowUnauthenticated: true }),
    allowedCwdRoots: ['/tmp'],
    profiles: hooks.profiles ?? PROFILES,
    engines: { claude: adapter('claude'), codex: adapter('codex') },
    sessions: { store: createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
    agentStore: createFileAgentStore(join(dir, 'agents.json')),
    parking: { parkDelayMs: 10 },
    historyReader: {
      read: async (target) => ({ kind: 'ok', events: [{ type: 'user_message', text: `from ${target.engineSessionId}` }] as never }),
    },
    onDiagnostic: (error) => hooks.diagnostics?.push(error),
    ...hooks.options,
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, built, base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

type Call = { status: number; body: Record<string, any> }

async function call(
  base: string,
  path: string,
  method = 'GET',
  body?: unknown,
  extra: { generation?: number; token?: string } = {},
): Promise<Call> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(extra.generation === undefined ? {} : { 'x-workerdeck-generation': String(extra.generation) }),
      ...(extra.token ? { authorization: `Bearer ${extra.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function createNamed(
  base: string,
  name: string,
  extra: Record<string, unknown> = {},
  request: Record<string, unknown> = {},
  token?: string,
) {
  const res = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a', ...request, agent: { name, ...extra } }, { token })
  expect(res.status).toBe(201)
  return res.body.session as SessionInfo
}

async function createPlain(base: string, request: Record<string, unknown> = {}): Promise<string> {
  const res = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a', ...request })
  expect(res.status).toBe(201)
  return (res.body.session as SessionInfo).id
}

async function idle(server: WorkerServer, id: string): Promise<void> {
  await vi.waitFor(() => expect(server.registry.get(id)?.info().status).toBe('idle'))
  await vi.waitFor(async () => expect((await server.records.get(id))?.cut).toBeUndefined())
}

async function stop(server: WorkerServer): Promise<void> {
  await server.parking.flush()
  await server.close()
  fixture.servers.splice(fixture.servers.indexOf(server), 1)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function tick(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cut(base: string, id: string, expectedGeneration: number, extra: Record<string, unknown> = {}, token?: string): Promise<Call> {
  return call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration, ...extra }, { token })
}

function runnersOf(built: Engine[], id: string): Engine[] {
  return built.filter((runner) => runner.id === id)
}

describe('retire with crew under one multi-lock', () => {
  it('waits for a cut in flight on a crew member, then closes that member at the conversation the cut started', async () => {
    const dir = await fixture.stateDir()
    const held = deferred()
    let member = ''
    const { server, base, built } = await gateway(dir, {
      building: (runner) => {
        if (runner.id === member && runnersOf(built, member).length === 2) {
          runner.hold = held.promise
        }
      },
    })
    const lead = await createNamed(base, 'Lead')
    member = (await createNamed(base, 'Member', { lead: lead.id })).id
    await idle(server, lead.id)
    await idle(server, member)

    const cutting = cut(base, member, 1)
    await vi.waitFor(() => expect(runnersOf(built, member)).toHaveLength(2))
    let retired = false
    const retiring = call(base, `/agents/${lead.id}`, 'DELETE', { members: 'retire', expectedGeneration: 1 }).then((res) => {
      retired = true
      return res
    })
    await tick()
    expect(retired).toBe(false)
    expect(server.registry.get(lead.id)).toBeDefined()

    held.resolve()
    expect((await cutting).status).toBe(200)
    expect(await retiring).toMatchObject({ status: 200, body: { retired: [lead.id, member], released: [] } })
    const record = await server.records.get(member)
    expect(record).toMatchObject({ closedAt: expect.any(Number), conversation: 2 })
    expect(record?.conversations.map((entry) => entry.n)).toEqual([1, 2])
    expect(runnersOf(built, member)).toHaveLength(2)
    expect(server.registry.get(member)).toBeUndefined()
  })

  it('refuses a cut on a crew member queued behind the retire, and starts no engine for it', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    await idle(server, lead.id)
    await idle(server, member.id)

    const gate = deferred()
    const blocking = server.locks.run([lead.id], () => gate.promise)
    const retiring = call(base, `/agents/${lead.id}`, 'DELETE', { members: 'retire', expectedGeneration: 1 })
    await tick(20)
    const late = cut(base, member.id, 1)
    await tick(20)
    gate.resolve()
    await blocking
    expect((await retiring).body).toEqual({ retired: [lead.id, member.id], released: [] })
    expect((await late).status).toBe(404)
    expect(runnersOf(built, member.id)).toHaveLength(1)
    expect(await server.records.get(member.id)).toMatchObject({ conversation: 1, closedAt: expect.any(Number) })
  })

  it('leaves a lead whose retire was refused for a team change fully usable, and a retry retires the new crew too', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createNamed(base, 'Lead')
    const first = await createNamed(base, 'First', { lead: lead.id })
    const late = await createNamed(base, 'Late')
    await idle(server, lead.id)
    const gate = deferred()
    const blocking = server.locks.run([first.id], () => gate.promise)
    const refused = call(base, `/agents/${lead.id}`, 'DELETE', { members: 'retire', expectedGeneration: 1 })
    await tick(20)
    expect((await call(base, `/agents/${late.id}`, 'PATCH', { lead: lead.id })).status).toBe(200)
    gate.resolve()
    await blocking
    expect((await refused).status).toBe(409)

    for (const id of [lead.id, first.id, late.id]) {
      expect(server.locks.gated(id)).toBe(false)
      expect(server.parking.fenced(id)).toBe(false)
    }
    expect((await cut(base, lead.id, 1)).status).toBe(200)
    await idle(server, lead.id)
    const retried = await call(base, `/agents/${lead.id}`, 'DELETE', { members: 'retire', expectedGeneration: 2 })
    expect(retried.body.retired.sort()).toEqual([lead.id, first.id, late.id].sort())
  })

  it.each([
    ['a lead with crew', true],
    ['a crew member', false],
  ])('answers DELETE of %s by its session route without deadlocking on the one id', async (_label, isLead) => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    await idle(server, lead.id)
    await idle(server, member.id)
    const target = isLead ? lead.id : member.id
    const res = await Promise.race([
      fetch(`${base}/sessions/${target}`, { method: 'DELETE', headers: { 'x-workerdeck-generation': '1' } }),
      tick(3000).then(() => 'deadlock' as const),
    ])
    expect(res).not.toBe('deadlock')
    expect((res as Response).status).toBe(200)
    expect(await server.records.get(target)).toMatchObject({ closedAt: expect.any(Number) })
    const other = isLead ? member.id : lead.id
    expect(server.registry.get(other)).toBeDefined()
    expect((await cut(base, other, 1)).status).toBe(200)
  })
})

describe('cross-store identity', () => {
  it('keeps a session whose index row never landed as a working unnamed session', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const session = await createNamed(first.base, 'Atlas')
    await idle(first.server, session.id)
    await stop(first.server)
    await writeFile(join(dir, 'agents.json'), JSON.stringify([]))

    const second = await gateway(dir)
    const listed = (await call(second.base, '/sessions')).body.sessions as SessionInfo[]
    expect(listed).toEqual([expect.objectContaining({ id: session.id })])
    expect(listed[0]!.agent).toBeUndefined()
    expect((await call(second.base, '/agents')).body.agents).toEqual([])
    expect((await cut(second.base, session.id, 1, { prompt: 'go on' })).status).toBe(200)
    await idle(second.server, session.id)
    expect(second.built.at(-1)!.sent).toEqual(['go on'])
    const renamed = await call(second.base, `/sessions/${session.id}`, 'PATCH', { agent: { name: 'Atlas' } }, { generation: 2 })
    expect(renamed.body.session.agent).toMatchObject({ id: session.id, name: 'Atlas' })
  })

  it('finishes the close of a tombstoned team member on startup and releases nothing twice', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const lead = await createNamed(first.base, 'Lead')
    const member = await createNamed(first.base, 'Member', { lead: lead.id })
    await idle(first.server, lead.id)
    await idle(first.server, member.id)
    await stop(first.server)
    const path = join(dir, 'agents.json')
    const rows = JSON.parse(await readFile(path, 'utf8')) as StoredAgent[]
    await writeFile(path, JSON.stringify(rows.map((row) => (row.id === member.id ? { ...row, retiredAt: 5 } : row))))

    const second = await gateway(dir)
    expect(await second.server.records.get(member.id)).toMatchObject({ closedAt: expect.any(Number), conversations: [{ n: 1 }] })
    expect(second.server.registry.get(member.id)).toBeUndefined()
    expect(second.server.locks.gated(member.id)).toBe(false)
    expect((await second.server.records.get(lead.id))?.closedAt).toBeUndefined()
    const listed = ((await call(second.base, '/sessions')).body.sessions as SessionInfo[]).map((info) => info.id)
    expect(listed).toEqual([lead.id])
  })

  it('drops an index row whose record is gone, logs it, and keeps the rest of the team intact', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const lead = await createNamed(first.base, 'Lead')
    const member = await createNamed(first.base, 'Member', { lead: lead.id })
    await idle(first.server, lead.id)
    await idle(first.server, member.id)
    await stop(first.server)
    await createFileSessionRecordStore({ dir: join(dir, 'sessions') }).delete(member.id)

    const diagnostics: unknown[] = []
    const second = await gateway(dir, { diagnostics })
    expect(((await call(second.base, '/agents')).body.agents as AgentInfo[]).map((agent) => agent.id)).toEqual([lead.id])
    expect(diagnostics.map(String)).toContainEqual(expect.stringContaining(`agent Member (${member.id}) has no session record`))
    expect(second.server.registry.get(member.id)).toBeUndefined()
  })

  it('refuses to un-name a lead or a member, and leaves the record and the index as they were', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    await idle(server, lead.id)
    await idle(server, member.id)
    const index = await readFile(join(dir, 'agents.json'), 'utf8')
    for (const id of [lead.id, member.id]) {
      const before = await server.records.get(id)
      const refused = await call(base, `/sessions/${id}`, 'PATCH', { agent: null }, { generation: 1 })
      expect(refused.status).toBe(409)
      expect(await server.records.get(id)).toEqual(before)
    }
    expect(await readFile(join(dir, 'agents.json'), 'utf8')).toBe(index)
    expect((await call(base, `/agents/${member.id}`, 'PATCH', { lead: null })).status).toBe(200)
    expect((await call(base, `/sessions/${member.id}`, 'PATCH', { agent: null }, { generation: 1 })).status).toBe(200)
    expect((await server.records.get(member.id))?.closedAt).toBeUndefined()
  })
})

describe('history under its frozen auth across an owner move', () => {
  it('lets the old owner read its old conversation only, and the new owner the current one and its own past only', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase } = await gateway(dir, { owners: true })
    const session = await createNamed(base, 'Atlas', { owner: 'alice' }, {}, 'operator')
    const id = session.id
    await idle(server, id)
    expect((await call(base, `/sessions/${id}`, 'GET', undefined, { token: 'alice' })).status).toBe(200)
    expect((await cut(base, id, 1, {}, 'operator')).status).toBe(200)
    await idle(server, id)
    expect((await call(base, `/agents/${id}`, 'PATCH', { owner: 'bob' }, { token: 'operator' })).status).toBe(200)
    expect((await cut(base, id, 2, {}, 'operator')).status).toBe(200)
    await idle(server, id)
    expect((await server.records.get(id))?.conversations.map((entry) => [entry.n, entry.auth.owner])).toEqual([
      [1, 'alice'],
      [2, 'bob'],
    ])

    expect((await call(base, `/sessions/${id}`, 'GET', undefined, { token: 'alice' })).status).toBe(404)
    expect((await call(base, `/sessions/${id}/conversations`, 'GET', undefined, { token: 'alice' })).body).toEqual({
      history: [expect.objectContaining({ n: 1 })],
    })
    const old = await call(base, `/sessions/${id}/conversations/1`, 'GET', undefined, { token: 'alice' })
    expect(old).toMatchObject({ status: 200, body: { info: { conversation: 1, owner: 'alice' } } })
    expect(old.body.info.agent).toBeUndefined()
    expect((await call(base, `/sessions/${id}/conversations/2`, 'GET', undefined, { token: 'alice' })).status).toBe(404)
    expect((await cut(base, id, 3, {}, 'alice')).status).toBe(404)

    expect((await call(base, `/sessions/${id}`, 'GET', undefined, { token: 'bob' })).status).toBe(200)
    const forBob = await call(base, `/sessions/${id}/conversations`, 'GET', undefined, { token: 'bob' })
    expect(forBob.body).toMatchObject({ conversation: 3, history: [expect.objectContaining({ n: 2 })] })
    expect(forBob.body.history).toHaveLength(1)
    expect((await call(base, `/sessions/${id}/conversations/1`, 'GET', undefined, { token: 'bob' })).status).toBe(404)
    expect((await call(base, `/sessions/${id}/conversations/2`, 'GET', undefined, { token: 'bob' })).status).toBe(200)

    const refusedUpgrade = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?conversation=1`, { headers: { authorization: 'Bearer bob' } })
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => resolve(101))
    })
    expect(refusedUpgrade).toBe(404)
    const history = new WebSocket(`${wsBase}/sessions/${id}/ws?conversation=1`, { headers: { authorization: 'Bearer alice' } })
    const frames = frameCollector(history)
    expect(await frames.waitFor((frame) => frame.type === 'attached')).toMatchObject({ session: { conversation: 1, owner: 'alice' } })
    history.close()
  })

  it('shows a past conversation with no owner as ownerless and unnamed after an owner, a rename and a reteam', async () => {
    const dir = await fixture.stateDir()
    const unowned = PROFILES.filter((profile) => profile.owner === undefined)
    const first = await gateway(dir, { owners: true, owner: undefined, profiles: unowned })
    const session = await createNamed(first.base, 'Atlas', {}, {}, 'operator')
    const id = session.id
    expect(session.owner).toBeUndefined()
    await idle(first.server, id)
    expect((await cut(first.base, id, 1, {}, 'operator')).status).toBe(200)
    await idle(first.server, id)
    await stop(first.server)

    const { base, wsBase } = await gateway(dir, { owners: true, owner: undefined })
    const lead = await createNamed(base, 'Lead', { owner: 'bob' }, { profile: 'claude-bob' }, 'operator')
    expect((await call(base, `/agents/${id}`, 'PATCH', { owner: 'bob' }, { token: 'operator' })).status).toBe(200)
    expect((await call(base, `/agents/${id}`, 'PATCH', { name: 'Renamed', lead: lead.id }, { token: 'operator' })).status).toBe(200)
    const current = await call(base, `/sessions/${id}`, 'GET', undefined, { token: 'bob' })
    expect(current.body.session).toMatchObject({
      owner: 'bob',
      agent: { name: 'Renamed', lead: lead.id },
    })

    const read = await call(base, `/sessions/${id}/conversations/1`, 'GET', undefined, { token: 'operator' })
    expect(read.status).toBe(200)
    expect(read.body.info).toMatchObject({ id, conversation: 1 })
    expect(read.body.info).not.toHaveProperty('owner')
    expect(read.body.info).not.toHaveProperty('agent')
    expect((await call(base, `/sessions/${id}/conversations/1`, 'GET', undefined, { token: 'bob' })).status).toBe(404)

    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?conversation=1`, { headers: { authorization: 'Bearer operator' } })
    const frames = frameCollector(ws)
    const attached = (await frames.waitFor((frame) => frame.type === 'attached')) as { session: SessionInfo }
    ws.close()
    expect(attached.session).toMatchObject({ id, conversation: 1 })
    expect(attached.session).not.toHaveProperty('owner')
    expect(attached.session).not.toHaveProperty('agent')
  })

  it('erases a past conversation for an operator: n kept as unavailable, the engine store never read again, n never reused', async () => {
    const dir = await fixture.stateDir()
    const reads: string[] = []
    const { server, base } = await gateway(dir, {
      options: {
        historyReader: {
          read: async (target) => {
            reads.push(target.engineSessionId ?? '')
            return { kind: 'ok', events: [{ type: 'user_message', text: 'old' }] as never }
          },
        },
      },
    })
    const id = await createPlain(base)
    await idle(server, id)
    expect((await cut(base, id, 1)).status).toBe(200)
    await idle(server, id)
    expect((await call(base, `/sessions/${id}/conversations/1`)).body.events).toHaveLength(1)
    expect(reads).toHaveLength(1)
    const before = (await server.records.get(id))!.conversations[0]!

    expect((await call(base, `/sessions/${id}/conversations/2`, 'DELETE')).status).toBe(409)
    expect((await call(base, `/sessions/${id}/conversations/9`, 'DELETE')).status).toBe(404)
    const erased = await call(base, `/sessions/${id}/conversations/1`, 'DELETE')
    expect(erased).toMatchObject({ status: 200, body: { erased: { n: 1, transcript: 'unavailable' } } })
    expect(erased.body.erased).not.toHaveProperty('engineSessionId')
    expect(erased.body.erased).not.toHaveProperty('title')

    const record = (await server.records.get(id))!
    expect(record.conversation).toBe(2)
    const entry = record.conversations[0]!
    expect(entry).toMatchObject({
      n: 1,
      transcript: 'unavailable',
      auth: before.auth,
      startedAt: before.startedAt,
      endedAt: before.endedAt,
    })
    expect([entry.cwd, entry.profile]).toEqual([before.cwd, before.profile])
    for (const key of ['engineSessionId', 'engineHome', 'snapshot', 'running', 'title', 'costUsd']) {
      expect(entry).not.toHaveProperty(key)
    }
    for (const executionId of before.executions) {
      expect(server.cuts.endedExecution(executionId)?.entry).toEqual(entry)
    }
    const read = await call(base, `/sessions/${id}/conversations/1`)
    expect(read).toMatchObject({ status: 200, body: { events: [], info: { conversation: 1, transcript: 'unavailable' } } })
    expect(reads).toHaveLength(1)
    expect((await call(base, `/sessions/${id}/conversations/1`, 'DELETE')).status).toBe(200)

    expect((await cut(base, id, 2)).status).toBe(200)
    await idle(server, id)
    expect((await server.records.get(id))?.conversations.map((candidate) => candidate.n)).toEqual([1, 2])
    expect((await fetch(`${base}/sessions/${id}`, { method: 'DELETE', headers: { 'x-workerdeck-generation': '3' } })).status).toBe(200)
    expect((await call(base, `/sessions/${id}/conversations/3`, 'DELETE')).status).toBe(200)
    expect((await call(base, `/sessions/${id}/conversations`)).body.history.map((row: { transcript?: string }) => row.transcript)).toEqual([
      'unavailable',
      undefined,
      'unavailable',
    ])
  })

  it('refuses an erase to anyone but an operator, with 404 for a reader who cannot see the conversation', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir, { owners: true })
    const session = await createNamed(base, 'Atlas', { owner: 'alice' }, {}, 'operator')
    await idle(server, session.id)
    expect((await cut(base, session.id, 1, {}, 'operator')).status).toBe(200)
    await idle(server, session.id)
    expect((await call(base, `/sessions/${session.id}/conversations/1`, 'DELETE', undefined, { token: 'bob' })).status).toBe(404)
    expect((await call(base, `/sessions/${session.id}/conversations/1`, 'DELETE', undefined, { token: 'alice' })).status).toBe(403)
    expect((await server.records.get(session.id))?.conversations[0]?.transcript).toBeUndefined()
    expect((await call(base, `/sessions/${session.id}/conversations/1`, 'DELETE', undefined, { token: 'operator' })).status).toBe(200)
  })
})

describe('the list from records: runtime absent is not a status', () => {
  it('gives closed for closedAt, the runtime kind without a runner, the runner status without a runtime, and failed with neither', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const closed = await createPlain(first.base)
    const dormant = await createPlain(first.base)
    await idle(first.server, closed)
    await idle(first.server, dormant)
    expect(
      (await fetch(`${first.base}/sessions/${closed}`, { method: 'DELETE', headers: { 'x-workerdeck-generation': '1' } })).status,
    ).toBe(200)

    const running = await createPlain(first.base)
    await idle(first.server, running)
    const runner = first.built.find((candidate) => candidate.id === running)!
    runner.busy()
    await first.server.records.transactDurable(running, (current) => {
      const { runtime: _runtime, ...rest } = current!
      return rest
    })
    const live = ((await call(first.base, '/sessions')).body.sessions as SessionInfo[]).find((info) => info.id === running)
    expect(live?.status).toBe('running')
    expect((await call(first.base, '/sessions')).body.sessions.map((info: SessionInfo) => info.id)).not.toContain(closed)
    expect((await call(first.base, '/sessions?closed=1')).body.sessions).toContainEqual(
      expect.objectContaining({ id: closed, status: 'closed' }),
    )
    runner.settle()
    await stop(first.server)

    const records = createFileSessionRecordStore({ dir: join(dir, 'sessions') })
    const stored = (await records.get(dormant))!
    expect(stored.runtime?.kind).toBe('dormant')
    const { runtime: _runtime, ...bare } = (await records.get(running))!
    await records.save(bare)

    const second = await gateway(dir)
    const listed = (await call(second.base, '/sessions')).body.sessions as SessionInfo[]
    expect(listed.find((info) => info.id === dormant)).toMatchObject({ status: stored.runtime!.info.status })
    expect(listed.find((info) => info.id === running)).toMatchObject({ status: 'failed' })
    expect(listed.map((info) => info.id)).not.toContain(closed)
    expect(second.built).toHaveLength(0)

    const ws = new WebSocket(`${second.wsBase}/sessions/${running}/ws`)
    const outcome = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => resolve(101))
    })
    expect(outcome).not.toBe(101)
    expect(second.built).toHaveLength(0)
    expect((await cut(second.base, running, 1)).status).not.toBe(200)
    expect(second.built).toHaveLength(0)
  })
})

describe('engine switch at the cut', () => {
  it('drops the model and a permission mode the new engine does not take; n+1 runs the new engine, the entry keeps the old', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await createPlain(base, { model: 'claude-model', permissionMode: 'plan' })
    await idle(server, id)
    expect(built[0]!.config).toMatchObject({ model: 'claude-model', permissionMode: 'plan' })
    expect((await cut(base, id, 1, { target: { profile: 'codex-b' } })).status).toBe(200)
    await idle(server, id)
    const fresh = built.at(-1)!
    expect(fresh.engine).toBe('codex')
    expect(fresh.config.profile).toBe('codex-b')
    expect(fresh.config.model).toBeUndefined()
    expect(fresh.config.permissionMode).toBeUndefined()
    const record = (await server.records.get(id))!
    expect(record.running).toMatchObject({ profile: 'codex-b' })
    expect(record.running).not.toHaveProperty('model')
    expect(record.running).not.toHaveProperty('permissionMode')
    expect(record.requested).toMatchObject({ profile: 'codex-b' })
    expect(record.requested).not.toHaveProperty('model')
    expect(record.requested).not.toHaveProperty('permissionMode')
    expect(record.conversations[0]).toMatchObject({
      n: 1,
      engine: 'claude',
      profile: 'claude-a',
      running: { model: 'claude-model', permissionMode: 'plan' },
    })
    expect((await call(base, `/sessions/${id}`)).body.session).toMatchObject({ engine: 'codex', profile: 'codex-b', conversation: 2 })
  })

  it('keeps a permission mode the new engine takes, and a model the target names', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await createPlain(base, { model: 'claude-model', permissionMode: 'acceptEdits' })
    await idle(server, id)
    expect((await cut(base, id, 1, { target: { profile: 'codex-b', model: 'codex-model' } })).status).toBe(200)
    await idle(server, id)
    expect(built.at(-1)!.config).toMatchObject({ profile: 'codex-b', model: 'codex-model', permissionMode: 'acceptEdits' })
  })

  it('writes running only at the cut: an Edit settings during a start lands in requested and runs from the next cut', async () => {
    const dir = await fixture.stateDir()
    const held = deferred()
    let id = ''
    const { server, base, built } = await gateway(dir, {
      building: (runner) => {
        if (runner.id === id && runnersOf(built, id).length === 2) {
          runner.hold = held.promise
        }
      },
    })
    id = (await createNamed(base, 'Wren', {}, { model: 'm1' })).id
    await idle(server, id)
    const cutting = cut(base, id, 1)
    await vi.waitFor(() => expect(runnersOf(built, id)).toHaveLength(2))
    const editing = call(base, `/agents/${id}`, 'PATCH', { config: { model: 'm2' } })
    await tick()
    held.resolve()
    expect((await cutting).status).toBe(200)
    expect((await editing).status).toBe(200)
    await idle(server, id)

    expect(runnersOf(built, id)[1]!.config.model).toBe('m1')
    const record = (await server.records.get(id))!
    expect(record.running?.model).toBe('m1')
    expect(record.requested?.model).toBe('m2')
    expect((await call(base, `/agents/${id}`)).body.agent.config.model).toBe('m2')

    expect((await cut(base, id, 2)).status).toBe(200)
    await idle(server, id)
    expect(runnersOf(built, id)[2]!.config.model).toBe('m2')
    expect((await server.records.get(id))?.running?.model).toBe('m2')
    expect((await server.records.get(id))?.conversations.map((entry) => entry.running?.model)).toEqual(['m1', 'm1'])
  })
})

describe('a job run refuses every cut door', () => {
  it('refuses REST, discard, a typed /clear, clear_context and context_reset, and stays on conversation 1', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir, { options: { agentContextReset: { default: true } } })
    const job = await createPlain(base, { meta: { jobId: 'j1' } })
    await idle(server, job)
    const runner = built[0]!

    const rest = await cut(base, job, 1)
    expect(rest).toMatchObject({ status: 409, body: { error: expect.stringContaining('job') } })
    const discard = await call(base, `/sessions/${job}/conversations/discard`, 'POST', { expectedGeneration: 1, inputRevision: 'any' })
    expect(discard).toMatchObject({ status: 409, body: { error: expect.stringContaining('job') } })

    const ws = new WebSocket(`${wsBase}/sessions/${job}/ws`)
    const frames = frameCollector(ws)
    await frames.waitFor((frame) => frame.type === 'attached')
    ws.send(JSON.stringify({ generation: 1, type: 'user_message', text: '/clear' }))
    expect(await frames.waitFor((frame) => frame.type === 'protocol_error')).toMatchObject({ message: expect.stringContaining('job') })
    const errors = () => frames.frames.filter((frame) => frame.type === 'protocol_error').length
    ws.send(JSON.stringify({ generation: 1, type: 'clear_context' }))
    await vi.waitFor(() => expect(errors()).toBe(2))
    expect(frames.frames.filter((frame) => frame.type === 'protocol_error').at(-1)).toMatchObject({
      message: expect.stringContaining('job'),
    })
    ws.close()
    expect(runner.sent).not.toContain('/clear')

    const directory = runner.config.contextReset
    expect(directory).toBeDefined()
    await expect(directory!.request(job, { prompt: 'next', reason: 'full' })).rejects.toThrow(/job/)

    expect(built).toHaveLength(1)
    expect((await server.records.get(job))?.conversation).toBe(1)
  })
})

describe('settings of the next conversation on every session', () => {
  it('writes requested for an unnamed session under its PATCH, applied at the next cut and never to the running one', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await createPlain(base, { model: 'm1', permissionMode: 'plan' })
    await idle(server, id)
    const edited = await call(base, `/sessions/${id}`, 'PATCH', { config: { model: 'm2', permissionMode: null } }, { generation: 1 })
    expect(edited.status).toBe(200)
    expect(edited.body.settings).toEqual({ cwd: '/tmp', profile: 'claude-a', model: 'm2' })
    expect(edited.body.session).toMatchObject({ id, model: 'm1' })
    const record = (await server.records.get(id))!
    expect(record.requested).toMatchObject({ model: 'm2' })
    expect(record.requested).not.toHaveProperty('permissionMode')
    expect(record.requested).not.toHaveProperty('agentContextReset')
    expect(record.running).toMatchObject({ model: 'm1', permissionMode: 'plan' })
    expect(built[0]!.config.model).toBe('m1')

    expect((await cut(base, id, 1)).status).toBe(200)
    await idle(server, id)
    expect(built.at(-1)!.config).toMatchObject({ model: 'm2' })
    expect(built.at(-1)!.config.permissionMode).toBeUndefined()
    expect(built.at(-1)!.config.contextReset).toBeUndefined()
    expect((await server.records.get(id))?.running).toMatchObject({ model: 'm2' })
  })

  it('refuses settings mixed with another key before writing anything', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const id = await createPlain(base, { model: 'm1' })
    await idle(server, id)
    const before = await server.records.get(id)
    for (const extra of [{ agent: 42 }, { agent: { name: 'Wren' } }, { title: 'x' }, { statusLabel: null }]) {
      const mixed = await call(base, `/sessions/${id}`, 'PATCH', { config: { model: 'm2' }, ...extra }, { generation: 1 })
      expect(mixed.status).toBe(400)
    }
    expect(await server.records.get(id)).toEqual(before)
  })

  it('validates the whole patch first and changes nothing on a refusal', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const id = await createPlain(base, { model: 'm1' })
    await idle(server, id)
    const before = await server.records.get(id)
    for (const [config, status] of [
      [{ brief: 'x' }, 400],
      [{ model: 5 }, 400],
      ['model', 400],
      [{ model: 'm2', profile: 'nope' }, 400],
      [{ model: 'm2', cwd: '/etc' }, 403],
    ] as const) {
      const refused = await call(base, `/sessions/${id}`, 'PATCH', { config }, { generation: 1 })
      expect({ config, status: refused.status }).toEqual({ config, status })
    }
    expect(await server.records.get(id)).toEqual(before)
  })

  it('edits a named session through its agent, so the agent shows the same settings', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const { id } = await createNamed(base, 'Wren', {}, { model: 'm1' })
    await idle(server, id)
    const edited = await call(base, `/sessions/${id}`, 'PATCH', { config: { model: 'm2' } }, { generation: 1 })
    expect(edited.body.settings).toMatchObject({ model: 'm2', agentContextReset: true })
    expect((await call(base, `/agents/${id}`)).body.agent.config.model).toBe('m2')
    expect((await server.records.get(id))?.requested?.model).toBe('m2')
    expect((await cut(base, id, 1)).status).toBe(200)
    await idle(server, id)
    expect(runnersOf(built, id).at(-1)!.config.model).toBe('m2')
  })

  it('refuses an edit while a cut is starting the next conversation, and one for a job run', async () => {
    const dir = await fixture.stateDir()
    const held = deferred()
    let id = ''
    const { server, base, built } = await gateway(dir, {
      building: (runner) => {
        if (runner.id === id && runnersOf(built, id).length === 2) {
          runner.hold = held.promise
        }
      },
    })
    id = await createPlain(base, { model: 'm1' })
    await idle(server, id)
    const cutting = cut(base, id, 1)
    await vi.waitFor(() => expect(runnersOf(built, id)).toHaveLength(2))
    const during = await call(base, `/sessions/${id}`, 'PATCH', { config: { model: 'm2' } }, { generation: 1 })
    expect(during.status).toBe(409)
    held.resolve()
    expect((await cutting).status).toBe(200)
    await idle(server, id)
    expect((await server.records.get(id))?.requested?.model).toBe('m1')
    expect((await call(base, `/sessions/${id}`, 'PATCH', { config: { model: 'm2' } }, { generation: 2 })).status).toBe(200)

    const job = await createPlain(base, { meta: { jobId: 'j1' } })
    await idle(server, job)
    expect((await call(base, `/sessions/${job}`, 'PATCH', { config: { model: 'm2' } }, { generation: 1 })).status).toBe(409)
  })
})
