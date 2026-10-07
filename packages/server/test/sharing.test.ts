import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { peerOps, type AgentRef, type AgentResponse, type ProfileInfo, type SessionInfo } from '@workerdeck/protocol'
import type { RelayOrigin } from '@workerdeck/relay-client'
import { createWorkerServer, type WorkerServerOptions } from '../src/index.ts'
import type { LateBoundRefs } from '../src/options.ts'
import { OwnerService } from '../src/services/owners.ts'
import { TeamLinks, type TeamTransport } from '../src/services/team-links.ts'
import { createMemoryAgentStore, type StoredAgent } from '../src/services/agent-store.ts'
import { AgentService } from '../src/services/agents.ts'
import { createPeerService, relayEntry } from '../src/services/peers.ts'
import { ProjectInfoService } from '../src/services/project-info.ts'
import { SessionRegistry } from '../src/services/registry.ts'
import { fakeHarness, listenOn } from './helpers.ts'
import { PeerRunner } from './peer-runner.ts'

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    await cleanup()
  }
})

async function gateway(extra: Partial<WorkerServerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wd-sharing-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const profiles: ProfileInfo[] = [
    { name: 'toby', configDir: dir, owner: 'tobias' },
    { name: 'box', configDir: dir, owner: 'silkweave', defaults: { sharing: 'shared' } },
  ]
  const harness = fakeHarness()
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles,
    owner: 'silkweave',
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    ...extra,
  })
  cleanups.push(() => server.close())
  const { base } = await listenOn(server)
  return async <T>(path: string, method = 'GET', body?: unknown) => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${base}${path}`, init)
    return { status: res.status, body: (await res.json()) as T }
  }
}

describe('peerOps across owners', () => {
  const ref = (id: string, extra: Partial<AgentRef> = {}): AgentRef => ({ id, name: id, ...extra })
  const shared = (id: string) => ref(id, { shared: true })

  it('opens a card and messages between two shared top-level agents, never a peek', () => {
    expect(peerOps({ owner: 'tobias', agent: shared('A') }, { owner: 'silkweave', agent: shared('B') }, true)).toEqual({
      list: true,
      send: true,
      peek: false,
    })
  })

  it('needs both sides shared, top-level and owned', () => {
    const none = { list: false, send: false, peek: false }
    expect(peerOps({ owner: 'tobias', agent: ref('A') }, { owner: 'silkweave', agent: shared('B') }, true)).toEqual(none)
    expect(peerOps({ owner: 'tobias' }, { owner: 'silkweave', agent: shared('B') }, true)).toEqual(none)
    expect(
      peerOps({ owner: 'tobias', agent: shared('A') }, { owner: 'silkweave', agent: ref('M', { lead: 'B', shared: true }) }, true),
    ).toEqual(none)
    expect(peerOps({ agent: shared('A') }, { owner: 'silkweave', agent: shared('B') }, false)).toEqual(none)
  })

  it('keeps a team across owners whatever the sharing, and sends nothing to a session without prompts', () => {
    const lead = { owner: 'silkweave', agent: ref('L') }
    const member = { owner: 'ruli', agent: ref('M', { lead: 'L' }) }
    expect(peerOps(lead, member, true)).toEqual({ list: true, send: true, peek: true })
    expect(peerOps(lead, { ...member, permissionMode: 'bypassPermissions' }, true)).toEqual({ list: true, send: false, peek: true })
    expect(
      peerOps({ owner: 'tobias', agent: shared('A') }, { owner: 'silkweave', agent: shared('B'), permissionMode: 'dontAsk' }, true),
    ).toEqual({
      list: false,
      send: false,
      peek: false,
    })
    expect(peerOps({ owner: 'tobias' }, { owner: 'tobias', permissionMode: 'bypassPermissions' }, true).send).toBe(true)
  })
})

describe('sharing on agents', () => {
  it('materializes the request, then the profile default, then the gateway default, and patches it', async () => {
    const call = await gateway()
    const plain = await call<AgentResponse>('/agents', 'POST', { name: 'Space', config: { cwd: '/tmp', profile: 'toby' } })
    expect(plain.body.agent.sharing).toBe('private')
    expect(plain.body.session?.agent?.shared).toBeUndefined()
    const box = await call<AgentResponse>('/agents', 'POST', { name: 'Box-Lead', config: { cwd: '/tmp', profile: 'box' } })
    expect(box.body.agent.sharing).toBe('shared')
    expect(box.body.session?.agent?.shared).toBe(true)
    const asked = await call<AgentResponse>('/agents', 'POST', {
      name: 'Stack',
      sharing: 'shared',
      config: { cwd: '/tmp', profile: 'toby' },
    })
    expect(asked.body.agent.sharing).toBe('shared')
    expect((await call('/agents', 'POST', { name: 'Odd', sharing: 'public', config: { cwd: '/tmp' } })).status).toBe(400)

    const lowered = await call<AgentResponse>(`/agents/${box.body.agent.id}`, 'PATCH', { sharing: 'private' })
    expect(lowered.body.agent.sharing).toBe('private')
    expect(lowered.body.session?.agent?.shared).toBeUndefined()
    expect((await call(`/agents/${box.body.agent.id}`, 'PATCH', { sharing: 'everyone' })).status).toBe(400)
  })

  it('takes the gateway default when the profile names none', async () => {
    const call = await gateway({ agentSharing: { default: 'shared' } })
    const agent = await call<AgentResponse>('/agents', 'POST', { name: 'Nova', config: { cwd: '/tmp', profile: 'toby' } })
    expect(agent.body.agent.sharing).toBe('shared')
  })

  it('refuses sharing on a gateway that shares nothing, and lands a shared default as private', async () => {
    const call = await gateway({ agentSharing: { allowShared: false } })
    const box = await call<AgentResponse>('/agents', 'POST', { name: 'Box-Lead', config: { cwd: '/tmp', profile: 'box' } })
    expect(box.body.agent.sharing).toBe('private')
    expect((await call('/agents', 'POST', { name: 'Stack', sharing: 'shared', config: { cwd: '/tmp' } })).status).toBe(409)
    expect((await call(`/agents/${box.body.agent.id}`, 'PATCH', { sharing: 'shared' })).status).toBe(409)
  })

  it('rejects a bad default at startup and a bad profile default', async () => {
    expect(() => createWorkerServer({ allowUnauthenticated: true, agentSharing: { default: 'open' as never } })).toThrow(/agentSharing/)
    const dir = await mkdtemp(join(tmpdir(), 'wd-sharing-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const bad = { name: 'p', configDir: dir, defaults: { sharing: 'open' as never } }
    expect(() => createWorkerServer({ allowUnauthenticated: true, profiles: [bad] })).toThrow(/defaults.sharing/)
  })
})

describe('what goes to the relay', () => {
  async function agents(allowShared?: boolean) {
    const service = new AgentService({
      store: createMemoryAgentStore(),
      basePath: '/v1',
      gateway: 'mini',
      ...(allowShared === undefined ? {} : { allowShared }),
    })
    await service.hydrate()
    const lead = (await service.create({
      ...(service.draft({ name: 'Box', sharing: 'shared' }) as StoredAgent),
      sessionId: 's1',
    })) as StoredAgent
    const member = service.draft({ name: 'Mate', sharing: 'shared', lead: lead.id }) as StoredAgent
    await service.create({ ...member, sessionId: 's2' })
    return service
  }

  it('marks only a top-level shared agent, and none while it runs without prompts', async () => {
    const service = await agents()
    expect(service.relayAgent('s1')?.shared).toBe(true)
    expect(service.relayAgent('s2')?.shared).toBeUndefined()
    const info = (mode: string) =>
      ({ id: 's1', status: 'idle', cwd: '/', createdAt: 1, pendingPermissionCount: 0, permissionMode: mode }) as SessionInfo
    expect(relayEntry(info('default'), true, service.relayAgent('s1')).agent?.shared).toBe(true)
    expect(relayEntry(info('bypassPermissions'), true, service.relayAgent('s1')).agent).not.toHaveProperty('shared')
  })

  it('shares nothing on a gateway that turned sharing off, without rewriting the record', async () => {
    const service = await agents(false)
    expect(service.relayAgent('s1')?.shared).toBeUndefined()
    expect(service.bySession('s1')?.sharing).toBe('shared')
    expect(service.decorate({ id: 's1' } as SessionInfo).agent?.shared).toBeUndefined()
  })
})

describe('shared agents on one gateway and through the relay', () => {
  function rig() {
    const registry = new SessionRegistry()
    const parties: Record<string, Pick<SessionInfo, 'owner' | 'agent' | 'permissionMode'>> = {
      stack: { owner: 'tobias', agent: { id: 'S', name: 'Stack-Lead', shared: true } },
      solo: { owner: 'tobias', agent: { id: 'P', name: 'Solo' } },
      box: { owner: 'silkweave', agent: { id: 'B', name: 'Box-Lead', shared: true } },
      mate: { owner: 'silkweave', agent: { id: 'M', name: 'Mate', lead: 'B' } },
      wild: { owner: 'silkweave', agent: { id: 'W', name: 'Wild', shared: true }, permissionMode: 'bypassPermissions' },
    }
    const projects = new ProjectInfoService({ decorate: (info) => ({ ...info, ...parties[info.id] }) })
    for (const id of Object.keys(parties)) {
      registry.register(new PeerRunner(id))
    }
    return { registry, service: createPeerService({ refs: { registry }, multiOwner: () => true, projects }) }
  }

  it('lists another owner shared agent as a card that takes messages but no peek', async () => {
    const { service } = rig()
    const rows = await service.list('stack')
    expect(rows.map((row) => row.id).sort()).toEqual(['box', 'solo'])
    const card = rows.find((row) => row.id === 'box')
    expect(card).toMatchObject({ cwd: '', pendingPermissionCount: 0, agent: 'Box-Lead' })
    expect(card).not.toHaveProperty('profile')
    expect(await service.peek('stack', 'box')).toBeUndefined()
    expect((await service.send('stack', 'box', 'pull and migrate')).delivered).toBe(true)
    expect(await service.list('solo')).toEqual([expect.objectContaining({ id: 'stack' })])
    expect((await service.send('solo', 'box', 'hi')).delivered).toBe(false)
    expect((await service.send('stack', 'mate', 'hi')).delivered).toBe(false)
    expect((await service.send('stack', 'wild', 'hi')).delivered).toBe(false)
  })

  it('checks an inbound relay frame per operation against the current record', async () => {
    const { registry, service } = rig()
    const origin: RelayOrigin = {
      gateway: 'mac',
      owner: 'tobias',
      sessionId: 'x',
      name: 'Stack-T',
      agent: { id: 'mac:T', name: 'Stack-T', shared: true },
      hops: [],
    }
    expect((await service.relaySend(origin, 'box', 'hello', undefined, 'mini')).delivered).toBe(true)
    expect(await service.relayPeek(origin, 'box', 4, undefined, 'mini')).toBeUndefined()
    const { shared: _shared, ...unshared } = origin.agent!
    expect((await service.relaySend({ ...origin, agent: unshared }, 'box', 'hello', undefined, 'mini')).delivered).toBe(false)
    expect((await service.relaySend(origin, 'wild', 'hello', undefined, 'mini')).delivered).toBe(false)
    expect(registry.get('box')).toBeDefined()
  })
})

describe('G review follow-ups', () => {
  type Party = Pick<SessionInfo, 'owner' | 'agent' | 'permissionMode'>

  it('checks a send again on the woken session, right before it lands', async () => {
    const parties: Record<string, Party> = {
      stack: { owner: 'tobias', agent: { id: 'S', name: 'Stack-Lead', shared: true } },
      box: { owner: 'silkweave', agent: { id: 'B', name: 'Box-Lead', shared: true } },
    }
    const registry = new SessionRegistry()
    const box = new PeerRunner('box')
    let wake: () => void = () => {}
    const refs: LateBoundRefs = {
      registry,
      parking: {
        listInfo: async () => [{ ...box.info(), status: 'parked' }],
        get: async (id: string) => (id === 'box' ? { id, info: { ...box.info(), status: 'parked' } } : null),
        ensureLive: async (id: string) => {
          await new Promise<void>((resolve) => (wake = resolve))
          registry.register(box)
          return registry.get(id)
        },
      } as unknown as LateBoundRefs['parking'],
    }
    const projects = new ProjectInfoService({ decorate: (info) => ({ ...info, ...parties[info.id] }) })
    const service = createPeerService({ refs, multiOwner: () => true, projects })
    registry.register(new PeerRunner('stack'))
    const origin: RelayOrigin = {
      gateway: 'mac',
      owner: 'tobias',
      sessionId: 'x',
      agent: { id: 'mac:T', name: 'T', shared: true },
      hops: [],
    }

    const lowered = service.send('stack', 'box', 'hello')
    await new Promise((resolve) => setTimeout(resolve, 10))
    parties.box = { ...parties.box, agent: { id: 'B', name: 'Box-Lead' } }
    wake()
    expect((await lowered).delivered).toBe(false)

    registry.evict('box')
    parties.box = { owner: 'silkweave', agent: { id: 'B', name: 'Box-Lead', shared: true } }
    const unprompted = service.relaySend(origin, 'box', 'hello', undefined, 'mini')
    await new Promise((resolve) => setTimeout(resolve, 10))
    parties.box = { ...parties.box, permissionMode: 'bypassPermissions' }
    wake()
    expect((await unprompted).delivered).toBe(false)
    expect(box.sent).toEqual([])
  })

  it('never lends the sender owner to a target that names none', async () => {
    const member = new PeerRunner('m')
    const registry = new SessionRegistry()
    registry.register(member)
    let mode: string | undefined = 'bypassPermissions'
    const projects = new ProjectInfoService({
      decorate: (info) => ({
        ...info,
        agent: { id: 'M', name: 'Mate', lead: 'mac:L' },
        permissionMode: mode as SessionInfo['permissionMode'],
      }),
    })
    const origin: RelayOrigin = { gateway: 'mac', owner: 'alice', sessionId: 'l', agent: { id: 'mac:L', name: 'Lead' }, hops: [] }
    const teams = { relayAgent: () => undefined, spansGateways: () => true, agentName: () => undefined, vouches: () => true }
    for (const defaultOwner of ['bob', undefined]) {
      const service = createPeerService({ refs: { registry }, teams, multiOwner: () => false, defaultOwner: () => defaultOwner, projects })
      expect((await service.relaySend(origin, 'm', 'hi', undefined, 'mini')).delivered).toBe(false)
    }
    mode = 'default'
    const service = createPeerService({ refs: { registry }, teams, multiOwner: () => false, defaultOwner: () => 'bob', projects })
    expect((await service.relaySend(origin, 'm', 'hi', undefined, 'mini')).delivered).toBe(true)
  })

  it('takes the one owner a gateway has as its default, even from a profile', () => {
    const owners = new OwnerService({ profiles: () => [{ name: 'p', owner: 'bob' }], relayOwners: () => ['bob'] })
    expect(owners.forProfile(undefined)).toBe('bob')
    expect(new OwnerService({ profiles: () => [{ name: 'p', owner: 'bob' }], relayOwners: () => ['alice'] }).defaultOwner()).toBeUndefined()
  })

  it('refuses a team across owners for an agent that runs without prompts, locally and remotely', async () => {
    const agents = new AgentService({ store: createMemoryAgentStore(), basePath: '/v1', gateway: 'mini' })
    await agents.hydrate()
    const make = async (name: string, owner: string, permissionMode?: 'bypassPermissions') =>
      (await agents.create(agents.draft({ name, owner, config: permissionMode ? { permissionMode } : {} }) as StoredAgent)) as StoredAgent
    const lead = await make('Lead', 'alice')
    const wild = await make('Wild', 'bob', 'bypassPermissions')
    expect(agents.leadRefusal(wild, lead.id, true)).toMatchObject({
      status: 409,
      error: expect.stringMatching(/without permission prompts/),
    })
    expect(agents.leadRefusal(await make('Tame', 'bob'), lead.id, true)).toBeNull()
    expect(agents.leadRefusal(await make('Own', 'alice', 'bypassPermissions'), lead.id)).toBeNull()

    const sent: Array<{ kind: string }> = []
    const transport: TeamTransport = {
      gateway: 'mini',
      ready: () => undefined,
      team: async (kind) => {
        sent.push({ kind })
        return { ok: true, leadName: 'Remote', owner: 'carol' }
      },
      teamStatus: async () => ({ edges: [] }),
      nudge: () => {},
    }
    const teams = new TeamLinks({ agents, transport })
    const joined = await teams.join(wild, 'mac:R', (remote) => agents.update(wild.id, { lead: 'mac:R' }, { joined: remote }))
    expect(joined).toMatchObject({ status: 409 })
    expect(sent.map((frame) => frame.kind)).toEqual(['team.join', 'team.leave'])
    expect(agents.get(wild.id)?.lead).toBeUndefined()

    const wildLead = await make('WildLead', 'alice', 'bypassPermissions')
    await teams.invite(wildLead, 'pi:M', 'dan')
    expect((await teams.inbound('team.join', { gateway: 'pi', owner: 'dan', agent: 'pi:M' }, wildLead.id, 'o1')).ok).toBe(false)
  })
})
