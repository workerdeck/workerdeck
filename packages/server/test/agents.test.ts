import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentInfo, AgentResponse, SessionInfo } from '@workerdeck/protocol'
import { createFileAgentStore, createFileSessionStore, createWorkerServer, type WorkerServerOptions } from '../src/index.ts'
import { fakeHarness, gatewayFixture, listenOn } from './helpers.ts'

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: [],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

const { servers, stateDir, cleanup } = gatewayFixture('wd-agents-')
afterEach(cleanup)

async function startGateway(dir?: string, extra: Pick<WorkerServerOptions, 'authenticate'> = {}) {
  const harness = fakeHarness()
  const server = createWorkerServer({
    allowUnauthenticated: extra.authenticate === undefined,
    ...extra,
    allowedCwdRoots: ['/tmp'],
    ...(dir
      ? { parking: { store: createFileSessionStore({ dir }), parkDelayMs: 10 }, agentStore: createFileAgentStore(join(dir, 'agents.json')) }
      : {}),
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  servers.push(server)
  const { base, wsBase } = await listenOn(server)
  return { server, harness, base, wsBase }
}

async function call<T>(base: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as T }
}

function appended(harness: ReturnType<typeof fakeHarness>): string | undefined {
  const prompt = harness.captured.options?.systemPrompt
  return typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'preset' ? prompt.append : undefined
}

describe('agents', () => {
  it('creates an agent with its first session and decorates that session everywhere it is listed', async () => {
    const { base } = await startGateway()
    const created = await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })
    expect(created.status).toBe(201)
    const { agent, session } = created.body
    expect(agent).toMatchObject({ name: 'Atlas', sessionId: session!.id, pastSessions: [], avatar: `/v1/agents/${agent.id}/avatar.png` })
    expect(agent).not.toHaveProperty('avatarSeed')
    expect(session!.agent).toEqual({ id: agent.id, name: 'Atlas', avatar: agent.avatar })

    const listed = await call<{ sessions: SessionInfo[] }>(base, '/sessions')
    expect(listed.body.sessions.find((s) => s.id === session!.id)?.agent?.name).toBe('Atlas')
    expect((await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents.map((a) => a.name)).toEqual(['Atlas'])
  })

  it('suggests a free name when none is given', async () => {
    const { base } = await startGateway()
    const first = await call<AgentResponse>(base, '/agents', 'POST', { config: { cwd: '/tmp/project' } })
    const second = await call<AgentResponse>(base, '/agents', 'POST', { config: { cwd: '/tmp/project' } })
    expect(first.body.agent.name).not.toBe(second.body.agent.name)
  })

  it('refuses a session request the create ladder refuses', async () => {
    const { base } = await startGateway()
    const res = await call<{ error: string }>(base, '/agents', 'POST', { config: { cwd: '/etc' } })
    expect(res.status).toBe(403)
  })

  it('delivers the brief as instructions and re-derives it after a restart, never persisting it in the session record', async () => {
    const dir = await stateDir()
    const first = await startGateway(dir)
    const { body } = await call<AgentResponse>(first.base, '/agents', 'POST', {
      name: 'Wren',
      config: { cwd: '/tmp/project', brief: 'You own the iOS client.' },
    })
    const sessionId = body.session!.id
    first.harness.emit(initMessage)
    await vi.waitFor(() => expect(appended(first.harness)).toBe('You own the iOS client.'))
    await vi.waitFor(async () => expect(await createFileSessionStore({ dir }).get(sessionId)).not.toBeNull())
    const raw = await readFile(join(dir, `${encodeURIComponent(sessionId)}.json`), 'utf8')
    expect(raw).not.toContain('You own the iOS client.')

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(dir)
    const ws = new WebSocket(`${second.wsBase}/sessions/${sessionId}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()
    const woken = await second.server.parking.ensureLive(sessionId)
    woken?.sendMessage('wake')
    await vi.waitFor(() => expect(appended(second.harness)).toBe('You own the iOS client.'))
    expect((await call<{ sessions: SessionInfo[] }>(second.base, '/sessions')).body.sessions[0]?.agent?.name).toBe('Wren')
  })

  it('forms one-level teams and says why a move is refused', async () => {
    const { base } = await startGateway()
    const make = async (name: string) =>
      (await call<AgentResponse>(base, '/agents', 'POST', { name, config: { cwd: '/tmp/project' } })).body
    const atlas = await make('Atlas')
    const pip = await make('Pip')
    const orbit = await make('Orbit')
    const fern = await make('Fern')

    expect((await call(base, `/agents/${pip.agent.id}`, 'PATCH', { lead: atlas.agent.id })).status).toBe(200)
    expect((await call(base, `/agents/${fern.agent.id}`, 'PATCH', { lead: orbit.agent.id })).status).toBe(200)

    const ontoMember = await call<{ error: string }>(base, `/agents/${orbit.agent.id}`, 'PATCH', { lead: pip.agent.id })
    expect(ontoMember).toEqual({ status: 409, body: { error: 'Pip is a member of a team; teams are one level deep' } })
    const leadMoving = await call<{ error: string }>(base, `/agents/${orbit.agent.id}`, 'PATCH', { lead: atlas.agent.id })
    expect(leadMoving).toEqual({ status: 409, body: { error: 'Orbit leads a team; teams are one level deep' } })
    expect((await call(base, `/agents/${atlas.agent.id}`, 'PATCH', { lead: atlas.agent.id })).status).toBe(409)

    const sessions = (await call<{ sessions: SessionInfo[] }>(base, '/sessions')).body.sessions
    const byName = (name: string) => sessions.find((s) => s.agent?.name === name)?.agent
    expect(byName('Pip')).toMatchObject({ lead: atlas.agent.id, team: 'Atlas' })
    expect(byName('Atlas')).toMatchObject({ leads: true })
    expect(byName('Atlas')).not.toHaveProperty('lead')

    expect((await call(base, `/agents/${pip.agent.id}`, 'PATCH', { lead: null })).status).toBe(200)
    const after = (await call<{ sessions: SessionInfo[] }>(base, '/sessions')).body.sessions
    expect(after.find((s) => s.agent?.name === 'Atlas')?.agent).not.toHaveProperty('leads')
  })

  it('retires a lead, releasing its members by default', async () => {
    const { base, server } = await startGateway()
    const lead = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const member = (
      await call<AgentResponse>(base, '/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp/project' }, lead: lead.agent.id })
    ).body
    expect(member.agent.lead).toBe(lead.agent.id)

    const retired = await call<{ retired: string[]; released: string[] }>(base, `/agents/${lead.agent.id}`, 'DELETE')
    expect(retired.body).toEqual({ retired: [lead.agent.id], released: [member.agent.id] })
    expect(server.registry.get(lead.session!.id)?.info().status).toBe('closed')
    const left = (await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents
    expect(left).toHaveLength(1)
    expect(left[0]).not.toHaveProperty('lead')
  })

  it('restarts an agent into a fresh session, keeping its identity and its team', async () => {
    const { base, server } = await startGateway()
    const lead = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const member = (
      await call<AgentResponse>(base, '/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp/project' }, lead: lead.agent.id })
    ).body
    const restarted = await call<AgentResponse>(base, `/agents/${member.agent.id}/restart`, 'POST', {})
    expect(restarted.status).toBe(200)
    expect(restarted.body.agent).toMatchObject({
      id: member.agent.id,
      name: 'Pip',
      lead: lead.agent.id,
      pastSessions: [member.session!.id],
    })
    expect(restarted.body.session!.id).not.toBe(member.session!.id)
    expect(restarted.body.session!.agent).toMatchObject({ name: 'Pip', team: 'Atlas' })
    expect(server.registry.get(member.session!.id)?.info().status).toBe('closed')
  })

  it('adopts an existing session as an agent', async () => {
    const { base } = await startGateway()
    const session = (await call<{ session: SessionInfo }>(base, '/sessions', 'POST', { cwd: '/tmp/project' })).body.session
    const adopted = await call<AgentResponse>(base, '/agents', 'POST', { adopt: session.id, name: 'Quill' })
    expect(adopted.status).toBe(201)
    expect(adopted.body.agent).toMatchObject({ name: 'Quill', sessionId: session.id, config: { cwd: '/tmp/project' } })
    expect((await call(base, '/agents', 'POST', { adopt: session.id })).status).toBe(409)
  })

  it('serves a stable avatar rolled once and persisted, with a cache validator', async () => {
    const { base } = await startGateway()
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const url = base.replace(/\/v1$/, '') + agent.avatar
    const first = await fetch(url)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await first.arrayBuffer())
    expect(String.fromCharCode(...bytes.subarray(1, 4))).toBe('PNG')
    const etag = first.headers.get('etag')!
    expect((await fetch(url, { headers: { 'if-none-match': etag } })).status).toBe(304)
    expect((await fetch(url)).headers.get('etag')).toBe(etag)
  })

  it('serves the busy animation as one strip with its frame durations', async () => {
    const { base } = await startGateway()
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const res = await fetch(base.replace(/\/v1$/, '') + agent.avatar.replace(/avatar\.png$/, 'avatar-busy.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-frame-durations')).toBe('160,160,160,160')
  })

  it('is operator-only: anyone else gets the same 404 as a missing route', async () => {
    const { base } = await startGateway(undefined, {
      authenticate: (req) => (req.headers.authorization === 'Bearer op' ? {} : { scope: { tenant: 't1' } }),
    })
    const res = await fetch(`${base}/agents`, { headers: { authorization: 'Bearer user' } })
    expect(res.status).toBe(404)
    expect((await fetch(`${base}/agents`, { headers: { authorization: 'Bearer op' } })).status).toBe(200)
  })
})
