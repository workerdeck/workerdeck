import type { SessionRunnerConfig } from '@workerdeck/core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_SLEEP_AFTER_MS_DEFAULT,
  isAgentFace,
  projectSwatch,
  rollFace,
  type AgentFace,
  type AgentInfo,
  type AgentResponse,
  type SessionInfo,
} from '@workerdeck/protocol'
import {
  createFileAgentStore,
  createFileSessionRecordStore,
  createWorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import { createMemoryAgentStore } from '../src/services/agent-store.ts'
import { AgentService } from '../src/services/agents.ts'
import { eventually, fakeHarness, fileRuntimeStore, gatewayFixture, listenOn } from './helpers.ts'

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

// A home of the file's own, so the default profile is the same with or without a ~/.claude on the host.
const HOME = mkdtempSync(join(tmpdir(), 'wd-agents-home-'))
const CLAUDE_CONFIG = join(HOME, '.claude')
beforeAll(() => {
  mkdirSync(CLAUDE_CONFIG)
  vi.stubEnv('HOME', HOME)
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
})
afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(HOME, { recursive: true, force: true })
})

// `ownQuery` gives every session its own fake query: closing one session then ends only its own stream.
async function startGateway(
  dir?: string,
  { ownQuery, ...extra }: Pick<WorkerServerOptions, 'authenticate'> & { ownQuery?: boolean } = {},
) {
  const harness = fakeHarness()
  const queryFn: typeof harness.queryFn = ownQuery ? (params) => fakeHarness().queryFn(params) : harness.queryFn
  const server = createWorkerServer({
    allowUnauthenticated: extra.authenticate === undefined,
    ...extra,
    allowedCwdRoots: ['/tmp'],
    profiles: [{ name: 'default', configDir: CLAUDE_CONFIG }],
    ...(dir
      ? {
          sessions: { store: createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
          parking: { parkDelayMs: 10 },
          agentStore: createFileAgentStore(join(dir, 'agents.json')),
        }
      : {}),
    buildRunnerConfig: (req) => ({ ...req, queryFn }),
  })
  servers.push(server)
  const { base, wsBase } = await listenOn(server)
  return { server, harness, base, wsBase }
}

async function call<T>(base: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method, headers: { 'x-workerdeck-generation': '1' } }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', 'x-workerdeck-generation': '1' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  return { status: res.status, body: (await res.json()) as T }
}

function appended(harness: ReturnType<typeof fakeHarness>): string | undefined {
  const prompt = harness.captured.options?.systemPrompt
  return typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'preset' ? prompt.append : undefined
}

function excludes(harness: ReturnType<typeof fakeHarness>): string[] | undefined {
  const settings = harness.captured.options?.settings
  return typeof settings === 'object' ? settings.claudeMdExcludes : undefined
}

describe('agents', () => {
  it('creates an agent with its first session and decorates that session everywhere it is listed', async () => {
    const { base } = await startGateway()
    const created = await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })
    expect(created.status).toBe(201)
    const { agent, session } = created.body
    expect(agent).toMatchObject({ name: 'Atlas', id: session!.id, face: { v: 1 } })
    expect(isAgentFace(agent.face)).toBe(true)
    expect(agent).not.toHaveProperty('avatarSeed')
    expect(session!.agent).toEqual({ id: agent.id, name: 'Atlas', face: agent.face })

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
    await eventually(() => expect(appended(first.harness)).toBe('You own the iOS client.'))
    await eventually(async () => expect(await fileRuntimeStore(join(dir, 'sessions')).get(sessionId)).not.toBeNull())
    // The brief rides the pending identity only until the first start is durable.
    await eventually(async () => expect((await first.server.records.get(sessionId))?.identity).toBeUndefined())
    const raw = await readFile(join(dir, 'sessions', `${encodeURIComponent(sessionId)}.json`), 'utf8')
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
    await eventually(() => expect(appended(second.harness)).toBe('You own the iOS client.'))
    expect((await call<{ sessions: SessionInfo[] }>(second.base, '/sessions')).body.sessions[0]?.agent?.name).toBe('Wren')
  })

  it('keeps an agent whose session never ran a turn across a restart, waking it fresh', async () => {
    const dir = await stateDir()
    const first = await startGateway(dir)
    const { body } = await call<AgentResponse>(first.base, '/agents', 'POST', { name: 'Wren', config: { cwd: '/tmp/project' } })
    const sessionId = body.session!.id
    await eventually(async () => expect(await fileRuntimeStore(join(dir, 'sessions')).get(sessionId)).not.toBeNull())

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(dir)
    const listed = (await call<{ sessions: SessionInfo[] }>(second.base, '/sessions')).body.sessions
    expect(listed.find((session) => session.id === sessionId)?.agent?.name).toBe('Wren')
    const woken = await second.server.parking.ensureLive(sessionId)
    woken?.sendMessage('wake')
    await eventually(() => expect(second.harness.captured.options).toBeDefined())
    expect(second.harness.captured.options?.resume).toBeUndefined()
  })

  it('scopes instruction files to the agent cwd and keeps the scope across a restart', async () => {
    const dir = await stateDir()
    const first = await startGateway(dir)
    const { body } = await call<AgentResponse>(first.base, '/agents', 'POST', {
      name: 'Wren',
      config: { cwd: '/tmp/project', instructionScope: 'cwd' },
    })
    const sessionId = body.session!.id
    first.harness.emit(initMessage)
    await eventually(() => expect(excludes(first.harness)).toContain('/tmp/AGENTS.md'))
    await eventually(async () => expect(await fileRuntimeStore(join(dir, 'sessions')).get(sessionId)).not.toBeNull())

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(dir)
    const woken = await second.server.parking.ensureLive(sessionId)
    woken?.sendMessage('wake')
    await eventually(() => expect(excludes(second.harness)).toContain('/tmp/AGENTS.md'))
  })

  it('leaves instruction loading alone by default and refuses an unknown scope', async () => {
    const { base, harness } = await startGateway()
    await call<AgentResponse>(base, '/agents', 'POST', { name: 'Wren', config: { cwd: '/tmp/project' } })
    harness.emit(initMessage)
    await eventually(() => expect(harness.captured.options).toBeDefined())
    expect(excludes(harness)).toBeUndefined()
    const refused = await call<{ error: string }>(base, '/agents', 'POST', { config: { cwd: '/tmp/project', instructionScope: 'repo' } })
    expect(refused).toEqual({ status: 400, body: { error: 'config.instructionScope must be one of ancestors, cwd' } })
  })

  it('clears a config key patched to null and keeps the keys left out', async () => {
    const { base } = await startGateway()
    const { body } = await call<AgentResponse>(base, '/agents', 'POST', {
      name: 'Wren',
      config: { cwd: '/tmp/project', model: 'claude-test-1', instructionScope: 'cwd' },
    })
    const patched = await call<AgentResponse>(base, `/agents/${body.agent.id}`, 'PATCH', {
      config: { instructionScope: null, sleepAfterMs: 0 },
    })
    expect(patched.status).toBe(200)
    // The engine settings read from the record's `requested`, which pins the profile the create resolved.
    expect(patched.body.agent.config).toEqual({ cwd: '/tmp/project', profile: 'default', model: 'claude-test-1', sleepAfterMs: 0 })
    expect((await call<AgentResponse>(base, `/agents/${body.agent.id}`)).body.agent.config).toEqual(patched.body.agent.config)
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

    const retired = await call<{ retired: string[]; released: string[] }>(base, `/agents/${lead.agent.id}`, 'DELETE', { expectedGeneration: 1 })
    expect(retired.body).toEqual({ retired: [lead.agent.id], released: [member.agent.id] })
    expect(server.registry.get(lead.session!.id)).toBeUndefined()
    expect(await server.records.get(lead.session!.id)).toMatchObject({ closedAt: expect.any(Number), conversations: [{ n: 1 }] })
    const left = (await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents
    expect(left).toHaveLength(1)
    expect(left[0]).not.toHaveProperty('lead')
  })

  it('retires the agent when its session is deleted, freeing the name and releasing its members', async () => {
    const { base } = await startGateway()
    const lead = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const member = (
      await call<AgentResponse>(base, '/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp/project' }, lead: lead.agent.id })
    ).body

    expect((await call(base, `/sessions/${lead.session!.id}`, 'DELETE')).status).toBe(200)
    const left = (await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents
    expect(left.map((a) => a.id)).toEqual([member.agent.id])
    expect(left[0]).not.toHaveProperty('lead')
    expect((await call(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).status).toBe(201)
  })

  it('refuses to delete an agent session for a caller who is not an operator', async () => {
    const { base } = await startGateway(undefined, {
      authenticate: (req) => (req.headers.authorization === 'Bearer op' ? {} : { scope: { tenant: 't1' } }),
    })
    const op = { authorization: 'Bearer op', 'content-type': 'application/json' }
    const created = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: op,
      body: JSON.stringify({ name: 'Atlas', config: { cwd: '/tmp/project' } }),
    })
    const { session } = (await created.json()) as AgentResponse
    const refused = await fetch(`${base}/sessions/${session!.id}`, {
      method: 'DELETE',
      headers: { 'x-workerdeck-generation': '1', authorization: 'Bearer user' },
    })
    expect(refused.status).not.toBe(200)
    expect(((await (await fetch(`${base}/agents`, { headers: op })).json()) as { agents: AgentInfo[] }).agents).toHaveLength(1)
  })

  it('starts a new conversation of an agent, keeping its identity and its team', async () => {
    const { base, server } = await startGateway(undefined, { ownQuery: true })
    const lead = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const member = (
      await call<AgentResponse>(base, '/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp/project' }, lead: lead.agent.id })
    ).body
    const restarted = await call<{ session: SessionInfo }>(base, `/sessions/${member.agent.id}/conversations`, 'POST', { expectedGeneration: 1 })
    expect(restarted.status).toBe(200)
    expect((await call<AgentResponse>(base, `/agents/${member.agent.id}`)).body.agent).toMatchObject({
      id: member.agent.id,
      name: 'Pip',
      lead: lead.agent.id,
    })
    expect(restarted.body.session.id).toBe(member.session!.id)
    const fresh = server.registry.get(member.agent.id) as unknown as { config: SessionRunnerConfig }
    expect(fresh.config.engineHome).toEqual({ claudeConfigDir: expect.any(String) })
    expect(restarted.body.session.agent).toMatchObject({ name: 'Pip', team: 'Atlas', conversation: 2 })
    expect(await server.records.get(member.agent.id)).toMatchObject({ conversation: 2, conversations: [{ n: 1 }] })
  })

  it('names an existing session through PATCH, under its own id, and refuses unsupported create fields', async () => {
    const { base, server } = await startGateway()
    const session = (await call<{ session: SessionInfo }>(base, '/sessions', 'POST', { cwd: '/tmp/project' })).body.session
    const adopt = await call<{ error: string }>(base, '/agents', 'POST', { adopt: session.id, name: 'Quill' })
    expect(adopt).toMatchObject({ status: 400, body: { error: 'unsupported field: adopt' } })
    const several = await call<{ error: string }>(base, '/agents', 'POST', { name: 'Quill', resume: 'x', team: 'y' })
    expect(several).toMatchObject({ status: 400, body: { error: 'unsupported fields: resume, team' } })
    expect(server.registry.list()).toHaveLength(1)
    expect((await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents).toEqual([])
    const named = await call<{ session: SessionInfo }>(base, `/sessions/${session.id}`, 'PATCH', { agent: { name: 'Quill' } })
    expect(named.status).toBe(200)
    expect(named.body.session.agent).toMatchObject({ id: session.id, name: 'Quill' })
    const agent = (await call<AgentResponse>(base, `/agents/${session.id}`)).body.agent
    expect(agent).toMatchObject({ id: session.id, name: 'Quill', config: { cwd: '/tmp/project' } })
  })

  it('rolls a face per seed, replaces or rerolls it, and refuses a malformed one', async () => {
    const { base } = await startGateway()
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    const chosen = await call<AgentResponse>(base, `/agents/${agent.id}/avatar`, 'POST', { seed: 'otter' })
    expect(chosen.status).toBe(200)
    expect(chosen.body.agent.face).toEqual(rollFace('otter', projectSwatch('/tmp/project')))
    const again = await call<AgentResponse>(base, `/agents/${agent.id}/avatar`, 'POST', { seed: 'otter' })
    expect(again.body.agent.face).toEqual(chosen.body.agent.face)
    const random = await call<AgentResponse>(base, `/agents/${agent.id}/avatar`, 'POST', {})
    expect(isAgentFace(random.body.agent.face)).toBe(true)
    const face: AgentFace = { v: 1, tile: { shape: 'boxy', color: 'steel' }, eyes: { kind: 'slit', color: 'teal/glow' } }
    expect((await call<AgentResponse>(base, `/agents/${agent.id}/avatar`, 'POST', { face })).body.agent.face).toEqual(face)
    expect((await call(base, `/agents/${agent.id}/avatar`, 'POST', { face: { v: 1, eyes: { kind: 'laser' } } })).status).toBe(400)
    expect((await call(base, `/agents/${agent.id}/avatar`, 'POST', { face: { v: 1, tile: { color: 'plaid' } } })).status).toBe(400)
    expect((await call(base, `/agents/${agent.id}/avatar`, 'POST', { seed: 'x'.repeat(65) })).status).toBe(400)
    expect((await fetch(`${base}/agents/${agent.id}/avatar.png`)).status).toBe(404)
  })

  it('offers change_avatar to an agent session, which rerolls or merges the parts it names', async () => {
    const { base, harness } = await startGateway()
    const { agent } = (await call<AgentResponse>(base, '/agents', 'POST', { name: 'Atlas', config: { cwd: '/tmp/project' } })).body
    await eventually(() => expect(harness.captured.options).toBeDefined())
    const servers = (harness.captured.options?.mcpServers ?? {}) as Record<string, { instance: unknown }>
    const tools = (
      servers.workerdeck!.instance as Record<string, Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>>
    )['_registeredTools']!
    expect(Object.keys(tools)).toContain('change_avatar')
    type Out = { content: { text: string }[]; isError?: boolean }
    const rolled = (await tools.change_avatar!.handler({ seed: 'heron' }, {})) as Out
    expect(rolled.isError).toBeFalsy()
    expect(rolled.content[0]!.text).toMatch(/avatar is rerolled/)
    const listed = async () => (await call<{ agents: AgentInfo[] }>(base, '/agents')).body.agents.find((a) => a.id === agent.id)!
    const heron = rollFace('heron', projectSwatch('/tmp/project'))
    expect((await listed()).face).toEqual(heron)
    const merged = (await tools.change_avatar!.handler({ visor: { kind: 'band' }, eyes: { color: 'amber' } }, {})) as Out
    expect(merged.content[0]!.text).toMatch(/avatar is changed/)
    expect((await listed()).face).toEqual({ ...heron, visor: { ...heron.visor, kind: 'band' }, eyes: { ...heron.eyes, color: 'amber' } })
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
    const agents = new AgentService({ store: createMemoryAgentStore(), sleepAfterMs: gateway })
    const draft = agents.draft({ id: 'session-1', name: 'Atlas', config: own === undefined ? {} : { sleepAfterMs: own } })
    if ('error' in draft) {
      throw new Error(draft.error)
    }
    await agents.create(draft)
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
