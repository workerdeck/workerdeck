import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentResponse, ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import { decodeFrame, encodeFrame, type RelaySessionEntry } from '@workerdeck/relay-client'
import { createWorkerServer } from '../src/index.ts'
import { createMemoryAgentStore, type StoredAgent } from '../src/services/agent-store.ts'
import { AgentService } from '../src/services/agents.ts'
import { OwnerService } from '../src/services/owners.ts'
import { createRelayLink } from '../src/services/peer-relay.ts'
import { createPeerService } from '../src/services/peers.ts'
import { ProjectInfoService } from '../src/services/project-info.ts'
import { SessionRegistry } from '../src/services/registry.ts'
import { TeamLinks, type TeamTransport } from '../src/services/team-links.ts'
import { fakeHarness, listenOn } from './helpers.ts'
import { PeerRunner } from './peer-runner.ts'

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    await cleanup()
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wd-owners-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function profiles(dir: string): ProfileInfo[] {
  return [
    { name: 'toby', configDir: dir, owner: 'tobias' },
    { name: 'ruli', configDir: dir, owner: 'ruli' },
    { name: 'loose', configDir: dir },
  ]
}

async function sharedGateway(owner: string | null = 'silkweave') {
  const dir = await tempDir()
  const harness = fakeHarness()
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: profiles(dir),
    ...(owner === null ? {} : { owner }),
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
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
  return { call }
}

describe('OwnerService', () => {
  const service = (owner?: string, relay: string[] = [], list: ProfileInfo[] = profiles('/x')) =>
    new OwnerService({ ...(owner === undefined ? {} : { owner }), profiles: () => list, relayOwners: () => relay })

  it('takes the profile owner, then the gateway default', () => {
    const owners = service('silkweave')
    expect(owners.forProfile('toby')).toBe('tobias')
    expect(owners.forProfile('loose')).toBe('silkweave')
    expect(owners.forProfile(undefined)).toBe('silkweave')
    expect(owners.multi()).toBe(true)
  })

  it('refuses a session whose owner resolves to nothing on a gateway of several owners', () => {
    const owners = service(undefined)
    expect(owners.resolve('toby')).toEqual({ owner: 'tobias' })
    expect(owners.resolve('loose')).toMatchObject({ status: 409, error: expect.stringMatching(/names no owner/) })
    expect(owners.resolve(undefined)).toMatchObject({ status: 409 })
  })

  it('takes an explicit owner only when the gateway knows it', () => {
    const owners = service('silkweave', ['silkweave', 'tobias', 'ruli', 'dan'])
    expect(owners.resolve('loose', 'dan')).toEqual({ owner: 'dan' })
    expect(owners.resolve('loose', 'eve')).toMatchObject({ status: 409 })
    expect(owners.resolve('loose', 'Not Valid')).toMatchObject({ status: 400 })
  })

  it('speaks for the relay sole owner only when nothing here names one', () => {
    expect(service(undefined, ['tobias'], []).defaultOwner()).toBe('tobias')
    expect(service(undefined, ['tobias', 'ruli'], []).defaultOwner()).toBeUndefined()
    expect(service(undefined, ['tobias'], [{ name: 'p', owner: 'ruli' }]).defaultOwner()).toBeUndefined()
    expect(service(undefined, [], []).multi()).toBe(false)
  })

  it('stays a gateway of several owners after a profile edit, and counts every owner the relay ever enrolled', () => {
    const list: ProfileInfo[] = [{ name: 'p', owner: 'alice' }]
    let relay: string[] = []
    const owners = new OwnerService({ profiles: () => list, relayOwners: () => relay })
    expect(owners.resolve('p')).toEqual({ owner: 'alice' })
    list[0] = { name: 'p', owner: 'bob' }
    expect(owners.multi()).toBe(true)

    const enrolledOnly = new OwnerService({ profiles: () => [], relayOwners: () => relay })
    relay = ['alice', 'bob']
    expect(enrolledOnly.resolve(undefined)).toMatchObject({ status: 409, error: expect.stringMatching(/names no owner/) })
    relay = []
    expect(enrolledOnly.multi()).toBe(true)
  })

  it('never stamps a relay-defaulted owner, but reads it while nothing else names one', () => {
    let defaulted = true
    let relay = ['operator']
    const list: ProfileInfo[] = []
    const owners = new OwnerService({ profiles: () => list, relayOwners: () => relay, relayDefaulted: () => defaulted })
    expect(owners.forProfile(undefined)).toBeUndefined()
    expect(owners.ownerFor(undefined)).toBe('operator')
    expect(owners.multi()).toBe(false)
    expect(owners.known('operator')).toBe(false)

    list.push({ name: 'p', owner: 'tobias' })
    expect(owners.multi()).toBe(false)
    expect(owners.ownerFor(undefined)).toBe('tobias')

    defaulted = false
    relay = ['tobias']
    expect(owners.forProfile(undefined)).toBe('tobias')
  })

  it('forgets a renamed-away owner once the records are rebuilt', () => {
    const owners = new OwnerService({ profiles: () => [] })
    owners.retain('operator')
    owners.retain('tobias')
    expect(owners.multi()).toBe(true)
    owners.rebuildRetained(['tobias', undefined])
    expect(owners.multi()).toBe(false)
    expect(owners.forProfile(undefined)).toBe('tobias')
  })

  it('rejects a malformed gateway owner at startup', () => {
    expect(() => service('Silk Weave')).toThrow(/owner/)
  })
})

describe('owners on a shared gateway', () => {
  it('stamps each session with its profile owner or the gateway default', async () => {
    const gw = await sharedGateway()
    const toby = await gw.call<{ session: SessionInfo }>('/sessions', 'POST', { cwd: '/tmp', profile: 'toby' })
    const loose = await gw.call<{ session: SessionInfo }>('/sessions', 'POST', { cwd: '/tmp', profile: 'loose' })
    expect(toby.body.session.owner).toBe('tobias')
    expect(loose.body.session.owner).toBe('silkweave')
    expect((await gw.call<{ session: SessionInfo }>(`/sessions/${toby.body.session.id}`)).body.session.owner).toBe('tobias')
  })

  it('refuses a session and an agent that resolve to no owner when the gateway has no default', async () => {
    const gw = await sharedGateway(null)
    const session = await gw.call<{ error: string }>('/sessions', 'POST', { cwd: '/tmp', profile: 'loose' })
    expect(session.status).toBe(409)
    expect(session.body.error).toMatch(/names no owner/)
    const agent = await gw.call<{ error: string }>('/agents', 'POST', { name: 'Nobody', config: { cwd: '/tmp', profile: 'loose' } })
    expect(agent.status).toBe(409)
    expect((await gw.call<{ session: SessionInfo }>('/sessions', 'POST', { cwd: '/tmp', profile: 'ruli' })).body.session.owner).toBe('ruli')
  })

  it('gives an agent its profile owner, an explicit known one, and its session the same', async () => {
    const gw = await sharedGateway()
    const ruli = await gw.call<AgentResponse>('/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp', profile: 'ruli' } })
    expect(ruli.body.agent.owner).toBe('ruli')
    expect(ruli.body.session?.owner).toBe('ruli')
    const lent = await gw.call<AgentResponse>('/agents', 'POST', {
      name: 'Lent',
      owner: 'tobias',
      config: { cwd: '/tmp', profile: 'ruli' },
    })
    expect(lent.body.agent.owner).toBe('tobias')
    expect(lent.body.session?.owner).toBe('tobias')
    const unknown = await gw.call<{ error: string }>('/agents', 'POST', {
      name: 'Eve',
      owner: 'eve',
      config: { cwd: '/tmp', profile: 'loose' },
    })
    expect(unknown.status).toBe(409)
  })

  it('asks for a confirmation before a team across owners, and moves an owner only outside teams', async () => {
    const gw = await sharedGateway()
    const lead = await gw.call<AgentResponse>('/agents', 'POST', { name: 'Box-Lead', config: { cwd: '/tmp', profile: 'loose' } })
    const pip = await gw.call<AgentResponse>('/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp', profile: 'ruli' } })
    const refused = await gw.call<{ error: string }>(`/agents/${pip.body.agent.id}`, 'PATCH', { lead: lead.body.agent.id })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('Pip belongs to ruli and Box-Lead to silkweave; confirm a team across owners')
    const joined = await gw.call<AgentResponse>(`/agents/${pip.body.agent.id}`, 'PATCH', { lead: lead.body.agent.id, crossOwner: true })
    expect(joined.status).toBe(200)

    const moved = await gw.call<{ error: string }>(`/agents/${pip.body.agent.id}`, 'PATCH', { owner: 'tobias' })
    expect(moved.status).toBe(409)
    expect(moved.body.error).toMatch(/owner moves only outside teams/)
    expect((await gw.call(`/agents/${lead.body.agent.id}`, 'PATCH', { owner: 'tobias' })).status).toBe(409)

    expect((await gw.call(`/agents/${pip.body.agent.id}`, 'PATCH', { lead: null })).status).toBe(200)
    const transferred = await gw.call<AgentResponse>(`/agents/${pip.body.agent.id}`, 'PATCH', { owner: 'tobias' })
    expect(transferred.body.agent.owner).toBe('tobias')
    expect(transferred.body.session?.owner).toBe('tobias')
    expect((await gw.call(`/agents/${pip.body.agent.id}`, 'PATCH', { owner: 'eve' })).status).toBe(409)
  })

  it('creates a member of another owner lead only with the confirmation', async () => {
    const gw = await sharedGateway()
    const lead = await gw.call<AgentResponse>('/agents', 'POST', { name: 'Box-Lead', config: { cwd: '/tmp', profile: 'loose' } })
    const body = { name: 'Pip', lead: lead.body.agent.id, config: { cwd: '/tmp', profile: 'ruli' } }
    expect((await gw.call('/agents', 'POST', body)).status).toBe(409)
    expect((await gw.call('/agents', 'POST', { ...body, crossOwner: true })).status).toBe(201)
  })
})

describe('owner rename', () => {
  it('moves agents, whole teams and live sessions, and refuses an unknown target', async () => {
    const gw = await sharedGateway()
    const lead = await gw.call<AgentResponse>('/agents', 'POST', { name: 'Lead', config: { cwd: '/tmp', profile: 'ruli' } })
    const pip = await gw.call<AgentResponse>('/agents', 'POST', { name: 'Pip', config: { cwd: '/tmp', profile: 'ruli' } })
    expect((await gw.call(`/agents/${pip.body.agent.id}`, 'PATCH', { lead: lead.body.agent.id })).status).toBe(200)
    const loose = await gw.call<{ session: SessionInfo }>('/sessions', 'POST', { cwd: '/tmp', profile: 'ruli' })

    expect((await gw.call<{ error: string }>('/owners/rename', 'POST', { from: 'ruli', to: 'eve' })).status).toBe(409)
    expect((await gw.call('/owners/rename', 'POST', { from: 'ruli', to: 'Not Valid' })).status).toBe(400)

    const renamed = await gw.call<{ agents: number; sessions: number }>('/owners/rename', 'POST', { from: 'ruli', to: 'tobias' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.agents).toBe(2)
    expect(renamed.body.sessions).toBeGreaterThanOrEqual(1)
    expect((await gw.call<AgentResponse>(`/agents/${pip.body.agent.id}`)).body.agent).toMatchObject({
      owner: 'tobias',
      lead: lead.body.agent.id,
    })
    expect((await gw.call<{ session: SessionInfo }>(`/sessions/${loose.body.session.id}`)).body.session.owner).toBe('tobias')
  })
})

describe('peers between owners on one gateway', () => {
  function rig(multiOwner: boolean) {
    const registry = new SessionRegistry()
    const owners: Record<string, string> = { t1: 'tobias', t2: 'tobias', r1: 'ruli', lead: 'silkweave', lent: 'ruli' }
    const agents: Record<string, SessionInfo['agent']> = { lead: { id: 'L', name: 'Box-Lead' }, lent: { id: 'P', name: 'Pip', lead: 'L' } }
    const service = createPeerService({
      refs: { registry },
      multiOwner: () => multiOwner,
      projects: new ProjectInfoService({
        decorate: (info) => ({
          ...info,
          ...(owners[info.id] ? { owner: owners[info.id] } : {}),
          ...(agents[info.id] ? { agent: agents[info.id] } : {}),
        }),
      }),
    })
    for (const id of [...Object.keys(owners), 'unowned']) {
      registry.register(new PeerRunner(id))
    }
    return service
  }
  const reach = async (service: ReturnType<typeof rig>, from: string) => (await service.list(from)).map((row) => row.id).sort()

  it('reaches only sessions of the same owner, plus its own team across owners', async () => {
    const service = rig(true)
    expect(await reach(service, 't1')).toEqual(['t2'])
    expect(await reach(service, 'r1')).toEqual([])
    expect(await reach(service, 'lead')).toEqual(['lent'])
    expect(await reach(service, 'lent')).toEqual(['lead'])
    expect(await service.send('t1', 'r1', 'hi')).toEqual({ delivered: false, reason: 'no such session: r1' })
    expect(await service.peek('r1', 't1')).toBeUndefined()
  })

  it('lets a session with no owner reach no session that has one', async () => {
    expect(await reach(rig(true), 'unowned')).toEqual([])
    expect(await reach(rig(false), 'unowned')).toEqual([])
  })
})

describe('agent records', () => {
  async function service(seed: StoredAgent[] = []) {
    const agents = new AgentService({ store: createMemoryAgentStore(seed), basePath: '/v1', gateway: 'mini' })
    await agents.hydrate()
    return agents
  }
  function record(id: string, extra: Partial<StoredAgent> = {}): StoredAgent {
    return { id, name: id, createdAt: 1, updatedAt: 1, avatarSeed: id, pastSessions: [], config: {}, schema: 2, ...extra }
  }

  it('stamps an owner once, only on records without one, from the resolver', async () => {
    const agents = await service([record('a', { config: { profile: 'toby' } }), record('b', { owner: 'ruli' }), record('c')])
    const count = await agents.stampOwners((agent) => (agent.config.profile === 'toby' ? 'tobias' : undefined))
    expect(count).toBe(1)
    expect(agents.get('a')?.owner).toBe('tobias')
    expect(agents.get('b')?.owner).toBe('ruli')
    expect(agents.get('c')?.owner).toBeUndefined()
    expect(await agents.stampOwners(() => 'dan')).toBe(1)
    expect(agents.get('a')?.owner).toBe('tobias')
    expect(agents.get('c')?.owner).toBe('dan')
  })

  it('refuses a transfer while an invitation or a pending join stands', async () => {
    const agents = await service([
      record('inviter', { remoteMembers: [{ agent: 'pi:M', state: 'invited', at: 1 }] }),
      record('joiner', { pendingJoin: { op: 'o', lead: 'pi:L', at: 1 } }),
      record('free'),
    ])
    expect(await agents.update('inviter', { owner: 'dan' })).toMatchObject({ status: 409 })
    expect(await agents.update('joiner', { owner: 'dan' })).toMatchObject({ status: 409 })
    expect(await agents.update('free', { owner: 'dan' })).toMatchObject({ owner: 'dan' })
  })

  it('renames nothing while an agent of the old owner holds an edge to another gateway', async () => {
    const agents = await service([
      record('inviter', { owner: 'operator', remoteMembers: [{ agent: 'pi:M', state: 'invited', at: 1 }] }),
      record('free', { owner: 'operator' }),
      record('other', { owner: 'ruli' }),
    ])
    expect(await agents.renameOwner('operator', 'tobias')).toMatchObject({ status: 409, error: expect.stringMatching(/^inviter hold/) })
    expect(agents.get('free')?.owner).toBe('operator')

    const clean = await service([record('free', { owner: 'operator' }), record('other', { owner: 'ruli' })])
    expect(await clean.renameOwner('operator', 'tobias')).toEqual({ renamed: 1 })
    expect(clean.owners().sort()).toEqual(['ruli', 'tobias'])
  })
})

describe('team links by agent owner', () => {
  function transport(sent: unknown[] = []): TeamTransport {
    return {
      gateway: 'mini',
      ready: () => undefined,
      team: async (kind, from, to, op, owner) => {
        sent.push({ kind, from, to, op, owner })
        return { ok: true, leadName: 'Lead', owner: 'tobias' }
      },
      teamStatus: async () => ({ edges: [] }),
      nudge: () => {},
    }
  }

  async function lead(owner: string) {
    const agents = new AgentService({ store: createMemoryAgentStore(), basePath: '/v1', gateway: 'mini' })
    await agents.hydrate()
    const created = await agents.create({ ...(agents.draft({ name: 'Lead', owner }) as StoredAgent) })
    return { agents, lead: created as StoredAgent }
  }

  it('waives the invitation only for an acceptFrom gateway joining a lead of the same owner', async () => {
    const { agents, lead: ruliLead } = await lead('ruli')
    const teams = new TeamLinks({ agents, transport: transport(), acceptFrom: ['mac'], owners: { defaultOwner: () => 'silkweave' } })
    expect(await teams.inbound('team.join', { gateway: 'mac', owner: 'tobias', agent: 'mac:M' }, ruliLead.id, 'o1')).toEqual({
      ok: false,
      reason: 'Lead has not invited this agent',
    })
    expect(await teams.inbound('team.join', { gateway: 'mac', owner: 'ruli', agent: 'mac:R' }, ruliLead.id, 'o2')).toMatchObject({
      ok: true,
    })
  })

  it('accepts an invitation only under the owner it named, and refuses a rejoin under another owner', async () => {
    const { agents, lead: tobyLead } = await lead('tobias')
    const teams = new TeamLinks({ agents, transport: transport() })
    await teams.invite(tobyLead, 'pi:M', 'dan')
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'ruli', agent: 'pi:M' }, tobyLead.id, 'o1')).ok).toBe(false)
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'dan', agent: 'pi:M' }, tobyLead.id, 'o2')).ok).toBe(true)
    expect(agents.get(tobyLead.id)?.remoteMembers).toMatchObject([{ agent: 'pi:M', owner: 'dan', state: 'accepted', op: 'o2' }])
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'ruli', agent: 'pi:M' }, tobyLead.id, 'o3')).ok).toBe(false)
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'dan', agent: 'pi:M' }, tobyLead.id, 'o4')).ok).toBe(true)
  })

  it('confirms a join retry and a status question only under the owner the edge was accepted with', async () => {
    const { agents, lead: tobyLead } = await lead('tobias')
    const teams = new TeamLinks({ agents, transport: transport() })
    await teams.invite(tobyLead, 'pi:M', 'alice')
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'alice', agent: 'pi:M' }, tobyLead.id, 'o1')).ok).toBe(true)
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'bob', agent: 'pi:M' }, tobyLead.id, 'o1')).ok).toBe(false)
    const ask = (owner: string) => teams.inboundStatus({ gateway: 'pi' }, { edges: [{ from: 'pi:M', to: tobyLead.id, op: 'o1', owner }] })
    expect((await ask('bob')).edges).toEqual([{ known: false }])
    expect((await ask('alice')).edges).toMatchObject([{ known: true }])
  })

  it('answers for a member only while its lead keeps the owner it joined under', async () => {
    const { agents } = await lead('tobias')
    const teams = new TeamLinks({ agents, transport: transport() })
    const mover = (await agents.create(agents.draft({ name: 'Pip', owner: 'tobias' }) as StoredAgent)) as StoredAgent
    await teams.join(mover, 'mac:L', (remote) => agents.update(mover.id, { lead: 'mac:L' }, { joined: remote }))
    const op = agents.get(mover.id)!.remoteLead!.op!
    const ask = (owner: string) => teams.inboundStatus({ gateway: 'mac' }, { edges: [{ from: 'mac:L', to: mover.id, op, owner }] })
    expect((await ask('ruli')).edges).toEqual([{ known: false }])
    expect((await ask('tobias')).edges).toMatchObject([{ known: true }])
  })

  it('sends the mover owner on its join and stores the lead owner the relay answered with', async () => {
    const sent: Array<{ owner?: string }> = []
    const { agents } = await lead('tobias')
    const teams = new TeamLinks({ agents, transport: transport(sent) })
    const mover = (await agents.create(agents.draft({ name: 'Pip', owner: 'ruli' }) as StoredAgent)) as StoredAgent
    const joined = await teams.join(mover, 'mac:L', (remote) => agents.update(mover.id, { lead: 'mac:L' }, { joined: remote }))
    expect(joined).toMatchObject({ lead: 'mac:L', remoteLead: { owner: 'tobias' } })
    expect(sent).toMatchObject([{ kind: 'team.join', owner: 'ruli' }])
  })
})

describe('a gateway of several owners on a relay without owners', () => {
  it('publishes nothing and refuses team frames', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => new Promise((resolve) => wss.close(resolve)))
    const snapshots: RelaySessionEntry[][] = []
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = decodeFrame(raw)
        if (frame?.t === 'hello') {
          socket.send(encodeFrame({ t: 'welcome', relayVersion: 1, features: ['teams'], owner: 'operator' }))
        }
        if (frame?.t === 'registry.snapshot') {
          snapshots.push(frame.entries as RelaySessionEntry[])
        }
      })
    })
    await new Promise((resolve) => wss.once('listening', resolve))
    const port = (wss.address() as { port: number }).port
    const registry = new SessionRegistry()
    registry.register(new PeerRunner('s1'))
    const peers = createPeerService({ refs: { registry }, projects: new ProjectInfoService() })
    const logged: string[] = []
    let multi = true
    const link = createRelayLink(
      { url: `ws://127.0.0.1:${port}`, gateway: 'mini', key: 'k' },
      peers,
      (line) => logged.push(line),
      undefined,
      { multiOwner: () => multi },
    )
    cleanups.push(() => link.close())
    await until(() => snapshots.length > 0, 'a snapshot')
    expect(snapshots[0]).toEqual([])
    expect(link.teamsUnavailable()).toMatch(/cannot tell the owners of this gateway apart/)
    await expect(link.team('team.join', 'A', 'mac:L', 'o')).rejects.toThrow(/cannot tell the owners/)
    expect(logged.some((line) => line.includes('publishes nothing'))).toBe(true)
    expect((await link.directory.list('s1')).map((row) => row.id)).toEqual([])
    multi = false
    expect(link.teamsUnavailable()).toBe('the relay does not route teams; upgrade it first')
  })
})

describe('a gateway of one configured owner on a relay without owners', () => {
  async function oldRelay(handle: (frame: Record<string, unknown>, reply: (result: unknown) => void) => void) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => new Promise((resolve) => wss.close(resolve)))
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = decodeFrame(raw) as Record<string, unknown> | undefined
        if (frame?.t === 'hello') {
          socket.send(encodeFrame({ t: 'welcome', relayVersion: 1, features: ['teams'], owner: 'operator' }))
          return
        }
        if (frame) {
          handle(frame, (result) => socket.send(encodeFrame({ t: 'res', id: frame.id as string, ok: true, result })))
        }
      })
    })
    await new Promise((resolve) => wss.once('listening', resolve))
    return `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
  }

  it('publishes nothing once a kept session carries another owner than the profile names now', async () => {
    const snapshots: RelaySessionEntry[][] = []
    const url = await oldRelay((frame) => {
      if (frame.t === 'registry.snapshot') {
        snapshots.push(frame.entries as RelaySessionEntry[])
      }
    })
    const owners = new OwnerService({ profiles: () => [{ name: 'p', owner: 'bob' }] })
    const registry = new SessionRegistry()
    registry.register(new PeerRunner('old', { owner: 'alice' }))
    registry.register(new PeerRunner('new', { owner: 'bob' }))
    const peers = createPeerService({ refs: { registry }, projects: new ProjectInfoService(), multiOwner: () => owners.multi() })
    expect(owners.multi()).toBe(false)
    const link = createRelayLink({ url, gateway: 'mini', key: 'k' }, peers, () => {}, undefined, {
      multiOwner: () => owners.multi(),
      retainStamped: () => {
        for (const info of registry.list()) {
          owners.retain(info.owner)
        }
      },
    })
    cleanups.push(() => link.close())
    await until(() => snapshots.length > 0, 'a snapshot')
    expect(snapshots.every((entries) => entries.length === 0)).toBe(true)
    expect(owners.multi()).toBe(true)
  })

  it('peeks a peer the old relay listed, taking its owner from the listed row', async () => {
    const row = {
      id: 'remote',
      gateway: 'other',
      owner: 'operator',
      allow: ['send', 'peek'],
      status: 'idle',
      cwd: '',
      createdAt: 1,
      pendingPermissionCount: 0,
      live: true,
    }
    const url = await oldRelay((frame, reply) => {
      if (frame.t === 'peer.list') {
        reply([row])
      }
      if (frame.t === 'peer.peek') {
        const { owner: _owner, gateway: _gateway, allow: _allow, ...entry } = row
        reply({ ...entry, pendingApprovals: [], recent: ['assistant: hi'] })
      }
    })
    const registry = new SessionRegistry()
    registry.register(new PeerRunner('s1'))
    const peers = createPeerService({ refs: { registry }, projects: new ProjectInfoService() })
    const link = createRelayLink({ url, gateway: 'mini', key: 'k' }, peers, () => {})
    cleanups.push(() => link.close())
    await until(async () => (await link.directory.list('s1')).some((peer) => peer.id === 'other:remote'), 'the listed peer')
    expect((await link.directory.peek('s1', 'other:remote'))?.recent).toEqual(['assistant: hi'])
  })
})
