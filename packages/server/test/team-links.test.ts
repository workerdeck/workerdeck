import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentInfo, AgentResponse, GatewayMeta } from '@workerdeck/protocol'
import { enrollGateway, startRelay, type Relay } from '@workerdeck/relay'
import type { TeamEdge, TeamResult, TeamStatusEdge } from '@workerdeck/relay-client'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { createFileAgentStore, createMemoryAgentStore, type StoredAgent } from '../src/services/agent-store.ts'
import { AgentService } from '../src/services/agents.ts'
import { TeamLinks, type TeamTransport } from '../src/services/team-links.ts'
import { fakeHarness, listenOn } from './helpers.ts'

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    await cleanup()
  }
})

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wd-team-links-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function relayRig(): Promise<{ relay: Relay; stateDir: string }> {
  const stateDir = await tempDir()
  await writeFile(join(stateDir, 'rules.json'), JSON.stringify({ rules: [{ from: '*', to: '*', allow: ['send', 'peek', 'team'] }] }))
  const relay = await startRelay({ stateDir, port: 0, log: () => {} })
  cleanups.push(() => relay.close())
  return { relay, stateDir }
}

type Gateway = { server: WorkerServer; base: string; call: <T>(path: string, method?: string, body?: unknown) => Promise<{ status: number; body: T }> }

async function gateway(relay: Relay, stateDir: string, name: string, acceptFrom?: string[]): Promise<Gateway> {
  const key = await enrollGateway(stateDir, name)
  await relay.reload()
  const harness = fakeHarness()
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    relay: { url: relay.url, gateway: name, key, expose: { allow: ['send', 'peek', 'team'] }, teams: { acceptFrom }, log: () => {} },
  })
  cleanups.push(() => server.close())
  const { base } = await listenOn(server)
  const call = async <T>(path: string, method = 'GET', body?: unknown) => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${base}${path}`, init)
    return { status: res.status, body: (await res.json()) as T }
  }
  await until(async () => (await call<GatewayMeta>('/meta')).body.relay?.features.includes('teams') === true, `${name} online`)
  return { server, base, call }
}

async function newAgent(gw: Gateway, name: string, lead?: string): Promise<AgentResponse> {
  const created = await gw.call<AgentResponse>('/agents', 'POST', { name, config: { cwd: '/tmp' }, ...(lead ? { lead } : {}) })
  expect(created.status).toBe(201)
  return created.body
}

async function agentOn(gw: Gateway, id: string): Promise<AgentInfo> {
  return (await gw.call<AgentResponse>(`/agents/${id}`)).body.agent
}

async function published(relay: Relay, name: string, count: number): Promise<void> {
  await until(() => relay.status().gateways.find((row) => row.name === name)?.sessions === count, `${name} publishes ${count}`)
}

describe('cross-gateway teams, same owner', () => {
  it('joins by invitation on the lead side plus a PATCH on the member side, and draws the member under its lead', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac')
    const win = await gateway(relay, stateDir, 'win')
    const lead = await newAgent(mac, 'AC-Lead')
    const member = await newAgent(win, 'AC-MagWin')
    await published(relay, 'mac', 1)
    await published(relay, 'win', 1)

    const refused = await win.call<{ error: string }>(`/agents/${member.agent.id}`, 'PATCH', { lead: `mac:${lead.agent.id}` })
    expect(refused).toEqual({ status: 409, body: { error: 'AC-Lead has not invited this agent' } })

    const invited = await mac.call<AgentResponse>(`/agents/${lead.agent.id}/remote-members`, 'POST', { agent: `win:${member.agent.id}` })
    expect(invited.body.agent.remoteMembers).toMatchObject([{ agent: `win:${member.agent.id}`, state: 'invited', owner: 'operator' }])

    const joined = await win.call<AgentResponse>(`/agents/${member.agent.id}`, 'PATCH', { lead: `mac:${lead.agent.id}` })
    expect(joined.status).toBe(200)
    expect(joined.body.agent).toMatchObject({ lead: `mac:${lead.agent.id}`, remoteLead: { name: 'AC-Lead', state: 'joined' } })
    expect(joined.body.session?.agent).toMatchObject({ lead: `mac:${lead.agent.id}`, leadGateway: 'mac', team: 'AC-Lead' })

    const leadNow = await mac.call<AgentResponse>(`/agents/${lead.agent.id}`)
    expect(leadNow.body.agent.remoteMembers).toMatchObject([{ agent: `win:${member.agent.id}`, name: 'AC-MagWin', state: 'accepted' }])
    expect(leadNow.body.session?.agent?.leads).toBe(true)
    await published(relay, 'win', 1)
  })

  it('accepts a same-owner join without an invitation from a gateway listed in acceptFrom', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac', ['win'])
    const win = await gateway(relay, stateDir, 'win')
    const lead = await newAgent(mac, 'AC-Lead')
    await published(relay, 'mac', 1)
    const member = await newAgent(win, 'Scout', `mac:${lead.agent.id}`)
    expect(member.agent).toMatchObject({ lead: `mac:${lead.agent.id}`, remoteLead: { name: 'AC-Lead' } })
    expect((await agentOn(mac, lead.agent.id)).remoteMembers?.[0]).toMatchObject({ agent: `win:${member.agent.id}`, state: 'accepted' })
  })

  it('keeps teams one level deep across gateways', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac', ['win'])
    const win = await gateway(relay, stateDir, 'win', ['mac'])
    const lead = await newAgent(mac, 'AC-Lead')
    const winLead = await newAgent(win, 'Win-Lead')
    await published(relay, 'mac', 1)
    const member = await newAgent(win, 'Scout', `mac:${lead.agent.id}`)

    const underMember = await win.call<{ error: string }>('/agents', 'POST', { name: 'Deep', config: { cwd: '/tmp' }, lead: member.agent.id })
    expect(underMember.body.error).toBe('Scout is a member of a team; teams are one level deep')

    const leadJoins = await mac.call<{ error: string }>(`/agents/${lead.agent.id}`, 'PATCH', { lead: `win:${winLead.agent.id}` })
    expect(leadJoins).toEqual({ status: 409, body: { error: 'AC-Lead leads a team; teams are one level deep' } })

    await mac.call(`/agents/${lead.agent.id}/remote-members`, 'POST', { agent: `win:${winLead.agent.id}` })
    const solo = await newAgent(mac, 'Solo')
    await mac.call(`/agents/${solo.agent.id}/remote-members`, 'POST', { agent: `win:${winLead.agent.id}` })
    const pending = await mac.call<{ error: string }>(`/agents/${solo.agent.id}`, 'PATCH', { lead: `win:${winLead.agent.id}` })
    expect(pending.body.error).toBe('Solo has open team invitations; withdraw them first')

    await published(relay, 'win', 2)
    const intoMember = await mac.call<{ error: string }>('/agents', 'POST', { name: 'Late', config: { cwd: '/tmp' }, lead: `win:${member.agent.id}` })
    expect(intoMember.status).toBe(409)
  })

  it('releases remote members when the lead retires, and drops the member when it leaves', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac', ['win'])
    const win = await gateway(relay, stateDir, 'win')
    const lead = await newAgent(mac, 'AC-Lead')
    await published(relay, 'mac', 1)
    const first = await newAgent(win, 'First', `mac:${lead.agent.id}`)
    const second = await newAgent(win, 'Second', `mac:${lead.agent.id}`)
    await published(relay, 'win', 2)

    expect((await win.call(`/agents/${second.agent.id}`, 'PATCH', { lead: null })).status).toBe(200)
    await until(async () => (await agentOn(mac, lead.agent.id)).remoteMembers?.length === 1, 'the lead drops the leaver')

    expect((await mac.call(`/agents/${lead.agent.id}`, 'DELETE', {})).status).toBe(200)
    await until(async () => (await agentOn(win, first.agent.id)).lead === undefined, 'the member is released')
    expect((await agentOn(win, first.agent.id)).remoteLead).toBeUndefined()
  })

  it('names the relay identity in meta for the operator', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac')
    expect((await mac.call<GatewayMeta>('/meta')).body.relay).toEqual({ gateway: 'mac', owner: 'operator', online: true, features: ['teams'] })
  })
})

type FakeTransport = TeamTransport & { statusCalls: Array<{ gateway: string; edges: TeamEdge[] }>; answer: (edges: TeamEdge[]) => TeamStatusEdge[] }

function fakeTransport(): FakeTransport & { down?: string } {
  const transport: FakeTransport & { down?: string } = {
    gateway: 'win',
    statusCalls: [],
    answer: (edges) => edges.map((edge) => ({ ...edge, known: true, name: 'AC-Lead renamed' })),
    ready: () => transport.down,
    owner: () => 'tobias',
    team: async (): Promise<TeamResult> => ({ ok: true, leadName: 'AC-Lead' }),
    teamStatus: async (gateway, edges) => {
      transport.statusCalls.push({ gateway, edges })
      return transport.answer(edges)
    },
    nudge: () => {},
  }
  return transport
}

async function memberRig(): Promise<{ agents: AgentService; teams: TeamLinks; transport: ReturnType<typeof fakeTransport>; member: StoredAgent }> {
  const agents = new AgentService({ store: createMemoryAgentStore(), basePath: '/v1', gateway: 'win', now: () => 1_000 })
  await agents.hydrate()
  const transport = fakeTransport()
  const teams = new TeamLinks({ agents, transport, now: () => 1_000 })
  const draft = agents.draft({ name: 'Scout' }) as StoredAgent
  await agents.create(draft)
  const member = await teams.join(draft, 'mac:L1', (joined) => agents.update(draft.id, { lead: 'mac:L1' }, { joined }))
  return { agents, teams, transport, member: member as StoredAgent }
}

describe('team reconcile', () => {
  it('keeps the edge while the lead is unreachable and marks it so', async () => {
    const { agents, teams, transport, member } = await memberRig()
    transport.down = 'remote gateways are unavailable right now; try again later'
    await teams.reconcile()
    expect(agents.get(member.id)).toMatchObject({ lead: 'mac:L1', remoteLead: { state: 'unreachable', name: 'AC-Lead' } })
    transport.down = undefined
    transport.answer = () => []
    await teams.reconcile()
    expect(agents.get(member.id)?.remoteLead?.state).toBe('unreachable')
    transport.answer = (edges) => edges.map((edge) => ({ ...edge, known: true, name: 'AC-Lead renamed' }))
    await teams.reconcile()
    expect(agents.get(member.id)?.remoteLead).toMatchObject({ state: 'joined', name: 'AC-Lead renamed' })
    expect(transport.statusCalls.at(-1)).toEqual({ gateway: 'mac', edges: [{ from: member.id, to: 'mac:L1' }] })
  })

  it('dissolves the edge only on an authoritative answer from the other gateway', async () => {
    const { agents, teams, transport, member } = await memberRig()
    transport.answer = (edges) => edges.map((edge) => ({ ...edge, known: false }))
    await teams.reconcile()
    expect(agents.get(member.id)?.lead).toBeUndefined()
    expect(agents.get(member.id)?.remoteLead).toBeUndefined()
  })

  it('answers status for the edges it holds and only to the gateway on their other end', async () => {
    const { teams, member } = await memberRig()
    expect(await teams.inboundStatus({ gateway: 'mac' }, [{ from: 'mac:L1', to: member.id }])).toEqual([{ known: true, name: 'Scout' }])
    expect(await teams.inboundStatus({ gateway: 'mac' }, [{ from: 'mac:L2', to: member.id }])).toEqual([{ known: false }])
    expect(await teams.inboundStatus({ gateway: 'pi' }, [{ from: 'mac:L1', to: member.id }])).toEqual([{ known: false }])
  })

  it('refuses an inbound join to an agent that is itself joining a team (the cross race)', async () => {
    const agents = new AgentService({ store: createMemoryAgentStore(), basePath: '/v1', gateway: 'win' })
    await agents.hydrate()
    const transport = fakeTransport()
    let release: (result: TeamResult) => void = () => {}
    transport.team = () => new Promise((resolve) => (release = resolve))
    const teams = new TeamLinks({ agents, transport, acceptFrom: ['mac'] })
    const mover = (await agents.create(agents.draft({ name: 'Scout' }) as StoredAgent)) as StoredAgent
    const joining = teams.join(mover, 'mac:L1', (joined) => agents.update(mover.id, { lead: 'mac:L1' }, { joined }))
    const inbound = await teams.inbound('team.join', { gateway: 'mac', owner: 'tobias', agent: 'mac:L1', name: 'AC-Lead' }, mover.id)
    expect(inbound).toEqual({ ok: false, reason: 'Scout is joining a team' })
    release({ ok: true, leadName: 'AC-Lead' })
    expect(await joining).toMatchObject({ lead: 'mac:L1' })
  })

  it('expires an unanswered invitation and refuses a join that relies on it', async () => {
    let now = 0
    const agents = new AgentService({ store: createMemoryAgentStore(), basePath: '/v1', gateway: 'mac', now: () => now })
    await agents.hydrate()
    const teams = new TeamLinks({ agents, transport: { ...fakeTransport(), gateway: 'mac' }, now: () => now, inviteTtlMs: 100 })
    const lead = (await agents.create(agents.draft({ name: 'AC-Lead' }) as StoredAgent)) as StoredAgent
    await teams.invite(lead, 'win:M1')
    now = 200
    const origin = { gateway: 'win', owner: 'tobias', agent: 'win:M1', name: 'Scout' }
    expect(await teams.inbound('team.join', origin, lead.id)).toEqual({ ok: false, reason: 'AC-Lead has not invited this agent' })
    await teams.reconcile()
    expect(agents.get(lead.id)?.remoteMembers).toEqual([])
  })

  it('persists both halves through the file store', async () => {
    const path = join(await tempDir(), 'agents.json')
    const agents = new AgentService({ store: createFileAgentStore(path), basePath: '/v1', gateway: 'mac' })
    await agents.hydrate()
    const lead = (await agents.create(agents.draft({ name: 'AC-Lead' }) as StoredAgent)) as StoredAgent
    await new TeamLinks({ agents, transport: { ...fakeTransport(), gateway: 'mac' } }).invite(lead, 'win:M1')
    const reread = new AgentService({ store: createFileAgentStore(path), basePath: '/v1', gateway: 'mac' })
    await reread.hydrate()
    expect(reread.get(lead.id)?.remoteMembers).toMatchObject([{ agent: 'win:M1', state: 'invited' }])
  })
})
