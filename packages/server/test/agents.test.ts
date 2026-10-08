import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_SLEEP_AFTER_MS_DEFAULT, type AgentInfo, type AgentResponse, type SessionInfo } from '@workerdeck/protocol'
import {
  createFileAgentStore,
  createFileSessionStore,
  createWorkerServer,
  type AvatarProvider,
  type WorkerServerOptions,
} from '../src/index.ts'
import { createMemoryAgentStore } from '../src/services/agent-store.ts'
import { AgentService } from '../src/services/agents.ts'
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

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

const { servers, stateDir, cleanup } = gatewayFixture('wd-agents-')
afterEach(cleanup)

function fakeAvatars(): AvatarProvider & { rolls: number } {
  return {
    rolls: 0,
    async roll(seed) {
      this.rolls++
      return { seed }
    },
    still: async (recipe) => ({ png: PNG, etag: `"still-${JSON.stringify(recipe)}"` }),
    busy: async (recipe) => ({ png: PNG, etag: `"busy-${JSON.stringify(recipe)}"`, durations: [160, 160] }),
  }
}

function gatedAvatars(): AvatarProvider & { hold(): void; release(): void; waiting(): number } {
  const base = fakeAvatars()
  let gate: Promise<void> | undefined
  let open: () => void = () => {}
  let waiting = 0
  return {
    ...base,
    roll: async (seed, engine, project) => {
      if (gate) {
        waiting++
        await gate
        waiting--
      }
      return base.roll(seed, engine, project)
    },
    hold: () => {
      gate = new Promise((resolve) => (open = resolve))
    },
    release: () => {
      gate = undefined
      open()
    },
    waiting: () => waiting,
  }
}

async function startGateway(dir?: string, extra: Pick<WorkerServerOptions, 'authenticate' | 'avatars'> = { avatars: fakeAvatars() }) {
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
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
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

  it('refuses a second agent of the same name, also on rename, ignoring case', async () => {
    const { base } = await startGateway()
    const atlas = await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })
    const twin = await call<{ error: string }>(base, '/agents', 'POST', { name: 'atlas', config: { cwd: '/tmp/project' } })
    expect(twin.status).toBe(409)
    expect(twin.body.error).toMatch(/named Atlas already exists/)
    const quill = await call<AgentResponse>(base, '/agents', 'POST', { name: 'Quill', config: { cwd: '/tmp/project' } })
    expect((await call(base, `/agents/${quill.body.agent.id}`, 'PATCH', { name: 'ATLAS' })).status).toBe(409)
    expect((await call(base, `/agents/${atlas.body.agent.id}`, 'PATCH', { name: 'atlas' })).status).toBe(200)
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
    expect(restarted.body.session!.agent).toMatchObject({ name: 'Pip', team: 'Atlas', conversation: 2 })
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
    const avatars = fakeAvatars()
    const { base } = await startGateway(undefined, { avatars })
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const url = base.replace(/\/v1$/, '') + agent.avatar
    const first = await fetch(url)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG)
    const etag = first.headers.get('etag')!
    expect((await fetch(url, { headers: { 'if-none-match': etag } })).status).toBe(304)
    expect((await fetch(url)).headers.get('etag')).toBe(etag)
    expect(avatars.rolls).toBe(1)
  })

  it('changes the avatar to a previewed seed or a random one, under a new address', async () => {
    const { base } = await startGateway()
    const origin = base.replace(/\/v1$/, '')
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const before = (await fetch(origin + agent.avatar)).headers.get('etag')
    const preview = await fetch(`${base}/agents/${agent.id}/avatar-preview.png?seed=otter`)
    expect(preview.status).toBe(200)
    const chosen = await call<AgentResponse>(base, `/agents/${agent.id}/avatar`, 'POST', { seed: 'otter' })
    expect(chosen.status).toBe(200)
    expect(chosen.body.agent.avatar).toMatch(new RegExp(`^/v1/agents/${agent.id}/avatar\\.png\\?v=[0-9a-f]{10}$`))
    const after = await fetch(origin + chosen.body.agent.avatar)
    expect(after.headers.get('etag')).toBe(preview.headers.get('etag'))
    expect(after.headers.get('etag')).not.toBe(before)
    expect(after.headers.get('cache-control')).toBe('private, no-cache')
    const random = await call<AgentResponse>(base, `/agents/${agent.id}/avatar`, 'POST', {})
    expect(random.body.agent.avatar).not.toBe(chosen.body.agent.avatar)
    expect((await call(base, `/agents/${agent.id}/avatar`, 'POST', { seed: 'x'.repeat(65) })).status).toBe(400)
    expect((await fetch(`${base}/agents/${agent.id}/avatar-preview.png`)).status).toBe(400)
  })

  it('offers change_avatar to an agent session only, and the tool rolls a new avatar', async () => {
    const { base, harness } = await startGateway()
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    const servers = (harness.captured.options?.mcpServers ?? {}) as Record<string, { instance: unknown }>
    const tools = (servers.workerdeck!.instance as Record<string, Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>>)['_registeredTools']!
    expect(Object.keys(tools)).toContain('change_avatar')
    const out = (await tools.change_avatar!.handler({ seed: 'heron' }, {})) as { content: { text: string }[]; isError?: boolean }
    expect(out.isError).toBeFalsy()
    expect(out.content[0]!.text).toMatch(/avatar is changed/)
    const listed = (await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents.find((a) => a.id === agent.id)!
    expect(listed.avatar).not.toBe(agent.avatar)
  })

  it('keeps a move and a retire that land while an avatar change is still rolling', async () => {
    const avatars = gatedAvatars()
    const { base } = await startGateway(undefined, { avatars })
    const lead = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Lead', config: { cwd: '/tmp/project' } })).body.agent
    const member = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Member', config: { cwd: '/tmp/project' } })).body.agent
    avatars.hold()
    const rolling = call<AgentResponse>(base, `/agents/${member.id}/avatar`, 'POST', { seed: 'otter' })
    await vi.waitFor(() => expect(avatars.waiting()).toBe(1))
    expect((await call(base, `/agents/${member.id}`, 'PATCH', { lead: lead.id })).status).toBe(200)
    avatars.release()
    const changed = await rolling
    expect(changed.status).toBe(200)
    expect(changed.body.agent).toMatchObject({ lead: lead.id })
    expect(changed.body.agent.avatar).not.toBe(member.avatar)

    avatars.hold()
    const late = call<{ error: string }>(base, `/agents/${member.id}/avatar`, 'POST', { seed: 'heron' })
    await vi.waitFor(() => expect(avatars.waiting()).toBe(1))
    expect((await call(base, `/agents/${member.id}`, 'DELETE', {})).status).toBe(200)
    avatars.release()
    expect(await late).toEqual({ status: 404, body: { error: `no such agent: ${member.id}` } })
    expect((await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents.map((a) => a.name)).toEqual(['Lead'])
  })

  it('serves the busy animation as one strip with its frame durations', async () => {
    const { base } = await startGateway()
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const res = await fetch(base.replace(/\/v1$/, '') + agent.avatar!.replace(/avatar\.png$/, 'avatar-busy.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-frame-durations')).toBe('160,160')
  })

  it('omits avatar and 404s the route on a gateway without an avatar provider', async () => {
    const { base } = await startGateway(undefined, {})
    const created = await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })
    expect(created.status).toBe(201)
    const { agent } = created.body
    expect(agent).not.toHaveProperty('avatar')
    expect((await call<{ sessions: SessionInfo[] }>(base, '/sessions')).body.sessions[0]!.agent).toEqual({ id: agent.id, name: 'Atlas' })
    expect((await fetch(`${base}/agents/${agent.id}/avatar.png`)).status).toBe(404)
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

describe('agent sleep default', () => {
  async function sleepAfter(gateway: number | undefined, own?: number): Promise<{ agent?: number; plain?: number }> {
    const agents = new AgentService({ store: createMemoryAgentStore(), basePath: '/v1', sleepAfterMs: gateway })
    const draft = agents.draft({ name: 'Atlas', config: own === undefined ? {} : { sleepAfterMs: own } })
    if ('error' in draft) {
      throw new Error(draft.error)
    }
    await agents.create({ ...draft, sessionId: 'session-1' })
    return { agent: agents.sleepAfterFor('session-1'), plain: agents.sleepAfterFor('session-2') }
  }

  it('falls back to 15 minutes, then the gateway default, and lets the agent override both', async () => {
    expect(await sleepAfter(undefined)).toEqual({ agent: AGENT_SLEEP_AFTER_MS_DEFAULT, plain: undefined })
    expect(await sleepAfter(60_000)).toEqual({ agent: 60_000, plain: undefined })
    expect(await sleepAfter(0)).toEqual({ agent: 0, plain: undefined })
    expect(await sleepAfter(0, 120_000)).toEqual({ agent: 120_000, plain: undefined })
    expect(await sleepAfter(60_000, 0)).toEqual({ agent: 0, plain: undefined })
  })
})
