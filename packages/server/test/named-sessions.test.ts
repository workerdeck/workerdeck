import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentInput, EngineAdapter, SendMessageOptions } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type AgentInfo, type ProfileInfo, type SessionInfo } from '@workerdeck/protocol'
import {
  createFileAgentStore,
  createFileSessionRecordStore,
  createWorkerServer,
  type AgentStore,
  type WorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import type { StoredAgent } from '../src/services/agent-store.ts'
import { LifecycleLocks } from '../src/services/lifecycle-locks.ts'
import { EngineRunner } from './engine-runner.ts'
import { gatewayFixture } from './helpers.ts'

const PROFILES: ProfileInfo[] = [{ name: 'claude-a', engine: 'claude', configDir: '/tmp' }]

const fixture = gatewayFixture('wd-named-')
afterEach(fixture.cleanup)

// Echoes what it is sent and answers nothing until told, so a test can hold a message unanswered.
class Engine extends EngineRunner {
  #pending = 0

  override info(): SessionInfo {
    return { ...super.info(), engine: 'claude', capabilities: { ...ENGINE_CAPABILITIES.claude, resume: true } }
  }

  override sendMessage(text: string, _attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    super.sendMessage(text)
    this.#pending++
    this.emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      ...(options?.origin ? { origin: options.origin } : {}),
    })
  }

  answer(): void {
    this.#pending = 0
    this.emit({ type: 'turn_result', subtype: 'success', isError: false, numTurns: 1, durationMs: 1, totalCostUsd: 0 } as never)
  }

  pendingInput(): number {
    return this.#pending
  }
}

type Hooks = { options?: Partial<WorkerServerOptions>; agentStore?: AgentStore; diagnostics?: unknown[] }

async function gateway(dir: string, hooks: Hooks = {}) {
  const built: Engine[] = []
  const adapter: EngineAdapter = {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => {
      const runner = new Engine(id ?? `s${built.length + 1}-${dir.slice(-6)}`, config)
      built.push(runner)
      return runner
    },
  }
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: PROFILES,
    engines: { claude: adapter },
    sessions: { store: createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
    agentStore: hooks.agentStore ?? createFileAgentStore(join(dir, 'agents.json')),
    parking: { parkDelayMs: 10 },
    historyReader: { read: async () => ({ kind: 'missing' }) },
    onDiagnostic: (error) => hooks.diagnostics?.push(error),
    ...hooks.options,
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, built, base: `http://127.0.0.1:${port}/v1` }
}

async function call(base: string, path: string, method = 'GET', body?: unknown, generation?: number) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(generation === undefined ? {} : { 'x-workerdeck-generation': String(generation) }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function createNamed(base: string, name: string, extra: Record<string, unknown> = {}): Promise<SessionInfo> {
  const res = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a', agent: { name, ...extra } })
  expect(res.status).toBe(201)
  return res.body.session as SessionInfo
}

async function idle(server: WorkerServer, id: string): Promise<void> {
  await vi.waitFor(() => expect(server.registry.get(id)?.info().status).toBe('idle'))
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

describe('a named session', () => {
  it('is created record first, then its index row, then started, all under the one id', async () => {
    const dir = await fixture.stateDir()
    const seen: Array<{ id: string; record: boolean }> = []
    let server: WorkerServer | undefined
    const store = createFileAgentStore(join(dir, 'agents.json'))
    const watching: AgentStore = {
      list: () => store.list(),
      apply: async (changes) => {
        for (const saved of changes.saves) {
          seen.push({ id: saved.id, record: (await server!.records.get(saved.id)) !== null && !server!.registry.get(saved.id) })
        }
        return store.apply(changes)
      },
    }
    const started = await gateway(dir, { agentStore: watching })
    server = started.server
    const session = await createNamed(started.base, 'Atlas', { brief: 'Keep it short.' })
    expect(seen).toEqual([{ id: session.id, record: true }])
    expect(session.agent).toMatchObject({ id: session.id, name: 'Atlas' })
    expect(started.built[0]!.config.instructions).toContain('Keep it short.')
    const agents = (await call(started.base, '/agents')).body.agents as AgentInfo[]
    expect(agents).toEqual([expect.objectContaining({ id: session.id, sessionId: session.id, pastSessions: [], config: expect.objectContaining({ cwd: '/tmp' }) })])
  })

  it('leaves nothing behind when the index write fails between the two writes', async () => {
    const dir = await fixture.stateDir()
    const store = createFileAgentStore(join(dir, 'agents.json'))
    const failing: AgentStore = {
      list: () => store.list(),
      apply: () => {
        throw new Error('disk full')
      },
    }
    const { server, base, built } = await gateway(dir, { agentStore: failing })
    const res = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a', agent: { name: 'Atlas' } })
    expect(res.status).toBe(500)
    expect(await server.records.list()).toEqual([])
    expect(server.registry.list()).toEqual([])
    expect(built[0]?.info().status).toBe('closed')
    expect((await call(base, '/sessions')).body.sessions).toEqual([])
  })

  it('names and un-names an unnamed session by PATCH; a team member or lead keeps its name', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const plain = (await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a' })).body.session as SessionInfo
    await idle(server, plain.id)
    const named = await call(base, `/sessions/${plain.id}`, 'PATCH', { agent: { name: 'Quill' } }, 1)
    expect(named.status).toBe(200)
    expect(named.body.session.agent).toMatchObject({ id: plain.id, name: 'Quill' })

    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    for (const id of [lead.id, member.id]) {
      const refused = await call(base, `/sessions/${id}`, 'PATCH', { agent: null }, 1)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toContain('is in a team')
    }

    const before = await server.records.get(plain.id)
    const unnamed = await call(base, `/sessions/${plain.id}`, 'PATCH', { agent: null }, 1)
    expect(unnamed.status).toBe(200)
    expect(unnamed.body.session.agent).toBeUndefined()
    expect(((await call(base, '/agents')).body.agents as AgentInfo[]).map((agent) => agent.name).sort()).toEqual(['Lead', 'Member'])
    expect(await server.records.get(plain.id)).toEqual(before)
  })

  it('keeps its id and identity through context_reset-style cuts and a typed restart', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const session = await createNamed(base, 'Wren')
    await idle(server, session.id)
    const restarted = await call(base, `/agents/${session.id}/restart`, 'POST', { prompt: 'again', expectedGeneration: 1 })
    expect(restarted.status).toBe(200)
    expect(restarted.body.agent).toMatchObject({ id: session.id, name: 'Wren', sessionId: session.id })
    expect(restarted.body.session).toMatchObject({ id: session.id, conversation: 2, agent: { id: session.id, name: 'Wren', conversation: 2 } })
    expect(built).toHaveLength(2)
    expect(built[1]!.sent).toEqual(['again'])
    expect(await server.records.get(session.id)).toMatchObject({ conversation: 2, conversations: [{ n: 1 }] })
  })
})

describe('retiring a named session', () => {
  it('tombstones first, closes the record, and releases its members', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    await idle(server, lead.id)
    const res = await fetch(`${base}/sessions/${lead.id}`, { method: 'DELETE', headers: { 'x-workerdeck-generation': '1' } })
    expect(res.status).toBe(200)
    expect(await server.records.get(lead.id)).toMatchObject({ closedAt: expect.any(Number), conversations: [{ n: 1 }] })
    expect(server.registry.get(lead.id)).toBeUndefined()
    expect(server.registry.get(member.id)).toBeDefined()
    const agents = (await call(base, '/agents')).body.agents as AgentInfo[]
    expect(agents).toEqual([expect.not.objectContaining({ lead: expect.anything() })])
    const retired = (await call(base, '/agents?retired=1')).body.retired
    expect(retired).toEqual([expect.objectContaining({ id: lead.id, conversations: [expect.objectContaining({ sessionId: lead.id })] })])
  })

  it('retires its members with it under one lock over every id, and refuses when the team changed meanwhile', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    await idle(server, member.id)

    const held = deferred()
    const holding = server.locks.run([member.id], () => held.promise)
    let finished = false
    const retiring = call(base, `/agents/${lead.id}`, 'DELETE', { members: 'retire', expectedGeneration: 1 }).then((res) => {
      finished = true
      return res
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(finished).toBe(false)
    expect(server.registry.get(lead.id)).toBeDefined()
    held.resolve()
    await holding
    expect((await retiring).body).toEqual({ retired: [lead.id, member.id], released: [] })
    for (const id of [lead.id, member.id]) {
      expect(await server.records.get(id)).toMatchObject({ closedAt: expect.any(Number) })
      expect(server.registry.get(id)).toBeUndefined()
    }

    const next = await createNamed(base, 'Next')
    const first = await createNamed(base, 'First', { lead: next.id })
    const late = await createNamed(base, 'Late')
    const gate = deferred()
    const blocking = server.locks.run([first.id], () => gate.promise)
    const refused = call(base, `/agents/${next.id}`, 'DELETE', { members: 'retire', expectedGeneration: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await call(base, `/agents/${late.id}`, 'PATCH', { lead: next.id })).status).toBe(200)
    gate.resolve()
    await blocking
    expect(await refused).toMatchObject({ status: 409, body: { error: "Next's team changed; try again" } })
    expect(server.registry.get(next.id)).toBeDefined()
  })
})

describe('startup reconciliation', () => {
  it('finishes the close of a tombstone whose record is still open', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const session = await createNamed(first.base, 'Atlas')
    await idle(first.server, session.id)
    await stop(first.server)
    const path = join(dir, 'agents.json')
    const rows = JSON.parse(await readFile(path, 'utf8')) as StoredAgent[]
    await writeFile(path, JSON.stringify(rows.map((row) => ({ ...row, retiredAt: 5 }))))

    const second = await gateway(dir)
    expect(await second.server.records.get(session.id)).toMatchObject({ closedAt: expect.any(Number), conversations: [{ n: 1 }] })
    expect((await call(second.base, '/agents')).body.agents).toEqual([])
    expect((await call(second.base, '/agents?retired=1')).body.retired).toEqual([expect.objectContaining({ id: session.id })])
  })

  it('drops an index row with no record, logs it, and leaves a row from before the merge alone', async () => {
    const dir = await fixture.stateDir()
    const orphan: StoredAgent = { id: 'gone', name: 'Gone', createdAt: 1, updatedAt: 1, avatarSeed: 'gone', config: {}, schema: 2 }
    const legacy = { ...orphan, id: 'old', name: 'Old', avatarSeed: 'old', sessionId: 'old-session', pastSessions: [] }
    await writeFile(join(dir, 'agents.json'), JSON.stringify([orphan, legacy]))
    const diagnostics: unknown[] = []
    const { base } = await gateway(dir, { diagnostics })
    expect(((await call(base, '/agents')).body.agents as AgentInfo[]).map((agent) => agent.id)).toEqual(['old'])
    expect(diagnostics.map(String)).toEqual([expect.stringContaining('agent Gone (gone) has no session record')])
    expect((JSON.parse(await readFile(join(dir, 'agents.json'), 'utf8')) as StoredAgent[]).map((row) => row.id)).toEqual(['old'])
  })
})

describe('the session list from records', () => {
  it('lists a record without runtime or runner as failed, refuses its wake, and closes it on delete', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = (await call(first.base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a', prompt: 'hi' })).body.session.id as string
    await idle(first.server, id)
    first.built[0]!.answer()
    expect((await call(first.base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(200)
    await stop(first.server)
    const records = createFileSessionRecordStore({ dir: join(dir, 'sessions') })
    const record = (await records.get(id))!
    const { runtime: _runtime, ...bare } = record
    await records.save(bare)

    const second = await gateway(dir)
    const listed = (await call(second.base, '/sessions')).body.sessions as SessionInfo[]
    expect(listed).toEqual([expect.objectContaining({ id, status: 'failed', conversation: 2 })])
    expect((await call(second.base, `/sessions/${id}`)).body.session).toMatchObject({ id, status: 'failed' })
    expect(await second.server.parking.ensureLive(id)).toBeUndefined()
    expect(second.built).toHaveLength(0)
    const closed = await fetch(`${second.base}/sessions/${id}`, { method: 'DELETE', headers: { 'x-workerdeck-generation': '2' } })
    expect(closed.status).toBe(200)
    expect((await call(second.base, '/sessions')).body.sessions).toEqual([])
    expect((await call(second.base, '/sessions?closed=1')).body.sessions).toEqual([expect.objectContaining({ id, status: 'closed' })])
  })
})

describe('peer messages across a cut', () => {
  it('holds the cut while a peer message is unanswered, refuses sends during the cut, and lands later ones in n+1', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const sender = await createNamed(base, 'Sender')
    const target = await createNamed(base, 'Target')
    await idle(server, target.id)
    const peers = built[0]!.config.peers!
    const first = built[1]!

    expect(await peers.send(sender.id, target.id, 'are you there')).toMatchObject({ delivered: true })
    const refused = await call(base, `/sessions/${target.id}/conversations`, 'POST', { expectedGeneration: 1 })
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringContaining('not answered') } })
    first.answer()

    server.locks.gate(target.id)
    expect(await peers.send(sender.id, target.id, 'mid cut')).toEqual({ delivered: false, reason: 'a new conversation is starting' })
    server.locks.ungate(target.id)

    expect((await call(base, `/sessions/${target.id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(200)
    await idle(server, target.id)
    const next = built.at(-1)!
    expect(next).not.toBe(first)
    expect(await peers.send(sender.id, target.id, 'after')).toMatchObject({ delivered: true, sessionId: target.id })
    expect(next.sent).toEqual(['after'])
    expect(first.sent).toEqual(['are you there'])
  })
})

describe('review probes', () => {
  it('keeps a retirement whose close failed fenced, gated and hidden, closes the other members, and finishes on retry', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const sender = await createNamed(base, 'Sender')
    const lead = await createNamed(base, 'Lead')
    const member = await createNamed(base, 'Member', { lead: lead.id })
    await idle(server, member.id)
    const original = server.records.transactDurable.bind(server.records)
    const failing = new Set([lead.id])
    server.records.transactDurable = ((id, merge) =>
      original(id, (current) => {
        const next = merge(current)
        if (failing.has(id) && next.closedAt !== undefined) {
          throw new Error('disk full')
        }
        return next
      })) as typeof server.records.transactDurable

    const res = await call(base, `/agents/${lead.id}`, 'DELETE', { members: 'retire', expectedGeneration: 1 })
    expect(res.status).toBe(500)
    expect(((await call(base, '/agents?retired=1')).body.retired as Array<{ id: string }>).map((row) => row.id).sort()).toEqual(
      [lead.id, member.id].sort(),
    )
    expect(server.registry.get(lead.id)).toBeDefined()
    expect((await server.records.get(lead.id))?.closedAt).toBeUndefined()
    expect(server.parking.fenced(lead.id)).toBe(true)
    expect(server.locks.gated(lead.id)).toBe(true)
    expect(await server.records.get(member.id)).toMatchObject({ closedAt: expect.any(Number) })
    expect(server.registry.get(member.id)).toBeUndefined()
    expect((await call(base, `/sessions/${lead.id}`)).status).toBe(404)
    expect((await call(base, `/sessions/${lead.id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(404)
    expect(((await call(base, '/sessions')).body.sessions as SessionInfo[]).map((info) => info.id)).toEqual([sender.id])
    expect(await built[0]!.config.peers!.send(sender.id, lead.id, 'still there?')).toMatchObject({ delivered: false })

    failing.clear()
    expect((await call(base, `/agents/${lead.id}`, 'DELETE', {})).status).toBe(200)
    expect(await server.records.get(lead.id)).toMatchObject({ closedAt: expect.any(Number) })
    expect(server.registry.get(lead.id)).toBeUndefined()
    expect(server.parking.fenced(lead.id)).toBe(false)
    expect(server.locks.gated(lead.id)).toBe(false)
  })

  it('refuses /agents lifecycle calls that name no conversation or a stale one', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const session = await createNamed(base, 'Wren')
    await idle(server, session.id)
    for (const path of ['restart', 'retry-start', 'undelivered']) {
      expect((await call(base, `/agents/${session.id}/${path}`, 'POST', {})).status).toBe(400)
    }
    expect((await call(base, `/agents/${session.id}`, 'DELETE', {})).status).toBe(400)
    expect((await call(base, `/agents/${session.id}/restart`, 'POST', { expectedGeneration: 1 })).status).toBe(200)
    expect((await call(base, `/agents/${session.id}/restart`, 'POST', { expectedGeneration: 1 })).status).toBe(409)
    expect((await server.records.get(session.id))?.conversation).toBe(2)
    expect((await call(base, `/agents/${session.id}`, 'DELETE', { expectedGeneration: 1 })).status).toBe(409)
    expect((await call(base, '/agents')).body.agents).toHaveLength(1)
  })

  it('validates a whole settings patch before writing, and reads set and cleared settings from the record', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    await createNamed(first.base, 'Taken')
    const res = await call(first.base, '/agents', 'POST', { name: 'Wren', config: { cwd: '/tmp', profile: 'claude-a', model: 'old' } })
    const id = res.body.agent.id as string
    const refused = await call(first.base, `/agents/${id}`, 'PATCH', { name: 'Taken', config: { model: 'new' } })
    expect(refused.status).toBe(409)
    expect((await first.server.records.get(id))?.requested?.model).toBe('old')
    expect((await call(first.base, `/agents/${id}`)).body.agent.config.model).toBe('old')
    const cleared = await call(first.base, `/agents/${id}`, 'PATCH', { config: { model: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.body.agent.config).not.toHaveProperty('model')
    expect((await first.server.records.get(id))?.requested?.model).toBeUndefined()

    await stop(first.server)
    const path = join(dir, 'agents.json')
    const rows = JSON.parse(await readFile(path, 'utf8')) as StoredAgent[]
    await writeFile(path, JSON.stringify(rows.map((row) => (row.id === id ? { ...row, config: { ...row.config, model: 'stale' } } : row))))
    await gateway(dir)
    const healed = (JSON.parse(await readFile(path, 'utf8')) as StoredAgent[]).find((row) => row.id === id)!
    expect(healed.config).not.toHaveProperty('model')
  })

  it('tells an abandoned create, a named one never started, and a session that ran without state apart', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const named = await createNamed(first.base, 'Atlas')
    const ran = (await call(first.base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a' })).body.session.id as string
    const abandoned = (await call(first.base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a' })).body.session.id as string
    await idle(first.server, ran)
    await stop(first.server)
    const records = createFileSessionRecordStore({ dir: join(dir, 'sessions') })
    for (const id of [named.id, ran, abandoned]) {
      const { runtime: _runtime, startedAt, ...bare } = (await records.get(id))!
      await records.save(id === ran ? { ...bare, startedAt } : bare)
    }

    const second = await gateway(dir)
    await idle(second.server, named.id)
    expect(second.built.map((runner) => runner.id)).toEqual([named.id])
    expect((await second.server.records.get(named.id))?.startedAt).toEqual(expect.any(Number))
    const listed = (await call(second.base, '/sessions')).body.sessions as SessionInfo[]
    expect(listed.map((info) => [info.id, info.status]).sort()).toEqual(
      [
        [named.id, 'idle'],
        [ran, 'failed'],
      ].sort(),
    )
  })
})

describe('lifecycle locks', () => {
  it('run overlapping id sets one after another, acquiring them together', async () => {
    const locks = new LifecycleLocks()
    const order: string[] = []
    const held = deferred()
    const first = locks.run(['b', 'a'], async () => {
      order.push('first')
      await held.promise
    })
    const second = locks.run(['a'], async () => {
      order.push('second')
    })
    const third = locks.run(['c'], async () => {
      order.push('third')
    })
    await third
    expect(order).toEqual(['first', 'third'])
    held.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'third', 'second'])
  })
})
