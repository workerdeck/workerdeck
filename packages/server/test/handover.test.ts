import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentConversationsResponse,
  AgentInfo,
  AgentResponse,
  ProfileInfo,
  RetiredAgentsResponse,
  SessionInfo,
} from '@workerdeck/protocol'
import { createFileAgentStore, createFileSessionRecordStore, createWorkerServer, type WorkerServer } from '../src/index.ts'
import type { StoredAgent } from '../src/services/agent-store.ts'
import { AgentHandovers } from '../src/services/handovers.ts'
import { EngineRunner } from './engine-runner.ts'
import { gatewayFixture } from './helpers.ts'

const profile: ProfileInfo = { name: 'engine', engine: 'provider', provider: { id: 'test', model: 'test-model' } }
const fixture = gatewayFixture('wd-handover-')
afterEach(fixture.cleanup)

async function gateway(dir: string) {
  const built: EngineRunner[] = []
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile],
    sessions: { store: createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
    parking: { parkDelayMs: 10 },
    agentStore: createFileAgentStore(join(dir, 'agents.json')),
    historyReader: { read: async () => ({ kind: 'missing' }) },
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

async function call(base: string, path: string, method?: string, body?: unknown): Promise<Response> {
  if (body === undefined || method === undefined) {
    return await fetch(`${base}${path}`, { method: method ?? 'GET' })
  }
  return await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function createAgent(base: string, name: string, lead?: string): Promise<AgentResponse> {
  const res = await call(base, '/agents', 'POST', { name, config: { cwd: '/tmp/project', profile: 'engine' }, prompt: 'work', lead })
  expect(res.status).toBe(201)
  return (await res.json()) as AgentResponse
}

async function agentOf(base: string, id: string): Promise<AgentInfo> {
  return ((await (await call(base, `/agents/${id}`)).json()) as AgentResponse).agent
}

async function listIds(base: string): Promise<string[]> {
  return ((await (await call(base, '/sessions')).json()) as { sessions: SessionInfo[] }).sessions.map((row) => row.id)
}

async function idle(server: WorkerServer, id: string): Promise<void> {
  await vi.waitFor(() => expect(server.registry.get(id)?.info().status).toBe('idle'))
}

function readAgents(dir: string): StoredAgent[] {
  return createFileAgentStore(join(dir, 'agents.json')).list() as StoredAgent[]
}

describe('agent handover', () => {
  it('rotates into a new conversation: old one archived and off the list, dates recorded, the prompt sent once', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)

    const res = await call(base, `/agents/${agent.id}/restart`, 'POST', { prompt: 'continue', expectedSessionId: session!.id })
    expect(res.status).toBe(200)
    const rotated = (await res.json()) as AgentResponse
    const fresh = rotated.session!.id
    expect(fresh).not.toBe(session!.id)
    expect(built.find((runner) => runner.id === fresh)?.sent).toEqual(['continue'])
    expect(await listIds(base)).toEqual([fresh])
    expect(((await (await call(base, `/sessions/${session!.id}`)).json()) as { session: SessionInfo }).session).toMatchObject({
      archived: true,
      supersededBy: fresh,
    })
    const conversations = rotated.agent.conversations!
    expect(conversations.map((entry) => entry.sessionId)).toEqual([session!.id, fresh])
    expect(conversations[0]).toMatchObject({ startedAt: expect.any(Number), endedAt: expect.any(Number) })
    expect(conversations[1]!.endedAt).toBeUndefined()
    expect(readAgents(dir).find((stored) => stored.id === agent.id)?.pending).toBeUndefined()

    const history = (await (await call(base, `/agents/${agent.id}/conversations`)).json()) as AgentConversationsResponse
    expect(history.conversations.map((row) => [row.sessionId, row.current])).toEqual([
      [fresh, true],
      [session!.id, false],
    ])
  })

  it('refuses a request made against a conversation the agent has already left', async () => {
    const { server, base } = await gateway(await fixture.stateDir())
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    const body = { expectedSessionId: session!.id }
    const [one, two] = await Promise.all([
      call(base, `/agents/${agent.id}/restart`, 'POST', body),
      call(base, `/agents/${agent.id}/restart`, 'POST', body),
    ])
    expect([one.status, two.status].sort()).toEqual([200, 409])
    expect((await agentOf(base, agent.id)).conversations).toHaveLength(2)
  })

  it('refuses a new conversation while the current one is busy, and leaves it untouched', async () => {
    const { server, base, built } = await gateway(await fixture.stateDir())
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    built.find((runner) => runner.id === session!.id)!.busy()
    const res = await call(base, `/agents/${agent.id}/restart`, 'POST', {})
    expect(res.status).toBe(409)
    expect((await agentOf(base, agent.id)).sessionId).toBe(session!.id)
    const send = await call(base, `/sessions/${session!.id}`, 'PATCH', { title: 'still mine' })
    expect(send.status).toBe(200)
  })

  it('leaves the old conversation usable when preparing the archive fails', async () => {
    const { server, base } = await gateway(await fixture.stateDir())
    const { agent, session } = await createAgent(base, 'Wren')
    await idle(server, session!.id)
    const spy = vi.spyOn(server.parking, 'archiveOf').mockRejectedValueOnce(new Error('disk full'))
    expect((await call(base, `/agents/${agent.id}/restart`, 'POST', {})).status).toBe(500)
    spy.mockRestore()
    expect((await agentOf(base, agent.id)).sessionId).toBe(session!.id)
    expect(await listIds(base)).toEqual([session!.id])
    expect((await call(base, `/sessions/${session!.id}`, 'PATCH', { title: 'fine' })).status).toBe(200)
  })

  it('finishes a committed rotation after a crash, sending a prompt nobody sent yet', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const { agent, session } = await createAgent(first.base, 'Wren')
    await idle(first.server, session!.id)
    await first.server.parking.flush()
    await first.server.close()
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)

    const store = createFileAgentStore(join(dir, 'agents.json'))
    const stored = readAgents(dir).find((entry) => entry.id === agent.id)!
    store.save({
      ...stored,
      sessionId: 'next-1',
      pastSessions: [session!.id],
      pending: { op: 'rotate', from: session!.id, to: 'next-1', prompt: 'resume', promptState: 'unsent', startedAt: 1 },
    })

    const second = await gateway(dir)
    expect(second.built.find((runner) => runner.id === 'next-1')?.sent).toEqual(['resume'])
    expect(readAgents(dir).find((entry) => entry.id === agent.id)?.pending).toBeUndefined()
    expect(await listIds(second.base)).toEqual(['next-1'])
  })

  it('never resends a first message whose delivery a crash left uncertain', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const { agent, session } = await createAgent(first.base, 'Wren')
    await idle(first.server, session!.id)
    await first.server.close()
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)

    const stored = readAgents(dir).find((entry) => entry.id === agent.id)!
    createFileAgentStore(join(dir, 'agents.json')).save({
      ...stored,
      sessionId: 'next-1',
      pending: { op: 'rotate', from: session!.id, to: 'next-1', prompt: 'resume', promptState: 'sending', startedAt: 1 },
    })

    const second = await gateway(dir)
    expect(second.built.find((runner) => runner.id === 'next-1')?.sent).toEqual([])
    expect((await agentOf(second.base, agent.id)).undelivered).toBe('resume')
    const resend = await call(second.base, `/agents/${agent.id}/undelivered`, 'POST', { send: true })
    expect(resend.status).toBe(200)
    expect(second.built.find((runner) => runner.id === 'next-1')?.sent).toEqual(['resume'])
    expect((await agentOf(second.base, agent.id)).undelivered).toBeUndefined()
  })

  it('deletes an agent into a tombstone that keeps its history and frees its name', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const lead = await createAgent(base, 'Lead')
    const member = await createAgent(base, 'Member', lead.agent.id)
    await idle(server, lead.session!.id)

    const res = await call(base, `/agents/${lead.agent.id}`, 'DELETE', { expectedSessionId: lead.session!.id })
    expect(res.status).toBe(200)
    expect((await agentOf(base, member.agent.id)).lead).toBeUndefined()
    expect(await listIds(base)).toEqual([member.session!.id])
    expect(((await (await call(base, `/sessions/${lead.session!.id}`)).json()) as { session: SessionInfo }).session.archived).toBe(true)

    const retired = (await (await call(base, '/agents?retired=1')).json()) as RetiredAgentsResponse
    expect(retired.retired.map((entry) => [entry.name, entry.conversations.length])).toEqual([['Lead', 1]])
    const history = (await (await call(base, `/agents/${lead.agent.id}/conversations`)).json()) as AgentConversationsResponse
    expect(history.conversations.map((row) => [row.sessionId, row.current, row.session?.archived])).toEqual([
      [lead.session!.id, false, true],
    ])

    expect((await createAgent(base, 'Lead')).agent.id).not.toBe(lead.agent.id)
    expect((await call(base, `/agents/${lead.agent.id}`, 'PATCH', { name: 'Back' })).status).toBe(404)
  })
})

describe('agent handover lock', () => {
  it('runs overlapping agent sets one after another, acquiring them together', async () => {
    const handovers = new AgentHandovers()
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const first = handovers.run(['b', 'a'], async () => {
      order.push('first')
      await held
    })
    const second = handovers.run(['a'], async () => {
      order.push('second')
    })
    const third = handovers.run(['c'], async () => {
      order.push('third')
    })
    await third
    expect(order).toEqual(['first', 'third'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'third', 'second'])
  })
})
