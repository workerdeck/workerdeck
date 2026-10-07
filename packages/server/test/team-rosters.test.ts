import { afterEach, describe, expect, it } from 'vitest'
import { parseRelayPeerId, readTeamRosters, type TeamFrameKind, type TeamResult, type TeamStatusAnswer } from '@workerdeck/relay-client'
import { createMemoryAgentStore, type AgentStore, type StoredAgent } from '../src/services/agent-store.ts'
import { AgentService, isAgentRefusal, legacyOp, normalizeAgent } from '../src/services/agents.ts'
import { TeamLinks, type TeamTransport } from '../src/services/team-links.ts'

type Node = { agents: AgentService; teams: TeamLinks; store: AgentStore }

const stops: Array<() => void> = []

afterEach(() => {
  for (let stop = stops.pop(); stop; stop = stops.pop()) {
    stop()
  }
})

// An in-process stand-in for the relay: it stamps origins and qualifies ids the way the real one does.
class Mesh {
  nodes = new Map<string, Node>()
  down = new Set<string>()
  dropped = new Set<TeamFrameKind>()
  clock = { now: 1_000 }

  transport(gateway: string): TeamTransport {
    return {
      gateway,
      ready: () => (this.down.has(gateway) ? 'remote gateways are unavailable right now; try again later' : undefined),
      team: async (kind, from, to, op): Promise<TeamResult> => {
        const target = parseRelayPeerId(to)
        const node = target && this.#reach(target.gateway)
        if (!target || !node) {
          throw new Error('unreachable')
        }
        if (this.dropped.has(kind)) {
          return { ok: true }
        }
        const name = this.nodes.get(gateway)?.agents.get(from)?.name
        return node.teams.inbound(kind, { gateway, owner: 'tobias', agent: `${gateway}:${from}`, ...(name ? { name } : {}) }, target.id, op)
      },
      teamStatus: async (targetName, body): Promise<TeamStatusAnswer> => {
        const node = this.#reach(targetName)
        if (!node || this.down.has(gateway)) {
          throw new Error('unreachable')
        }
        const answer = await node.teams.inboundStatus(
          { gateway },
          {
            edges: body.edges.map((edge) => ({ ...edge, from: `${gateway}:${edge.from}`, to: parseRelayPeerId(edge.to)!.id })),
            rosters: readTeamRosters(body.rosters, gateway),
            seen: body.seen ?? [],
          },
        )
        const edges = body.edges.flatMap((edge, index) => {
          const row = answer.edges[index]
          return typeof row?.known === 'boolean' ? [{ ...edge, known: row.known, ...(row.name ? { name: row.name } : {}), ...(row.owner ? { owner: row.owner } : {}) }] : []
        })
        return { edges, rosters: readTeamRosters(answer.rosters, targetName), seen: answer.seen ?? [] }
      },
      nudge: () => {},
    }
  }

  async add(
    gateway: string,
    store: AgentStore = createMemoryAgentStore(),
    options: { soonMs?: number; start?: boolean } = {},
  ): Promise<Node> {
    const agents = new AgentService({ store, basePath: '/v1', gateway, now: () => this.clock.now })
    await agents.hydrate()
    const teams = new TeamLinks({
      agents,
      owners: { defaultOwner: () => 'tobias' },
      transport: this.transport(gateway),
      acceptFrom: ['mac', 'win', 'pi'],
      now: () => this.clock.now,
      soonMs: options.soonMs,
    })
    if (options.start) {
      teams.start()
      stops.push(() => teams.stop())
    }
    const node = { agents, teams, store }
    this.nodes.set(gateway, node)
    return node
  }

  #reach(gateway: string): Node | undefined {
    return this.down.has(gateway) ? undefined : this.nodes.get(gateway)
  }
}

async function agent(node: Node, name: string): Promise<StoredAgent> {
  const created = await node.agents.create(node.agents.draft({ name }) as StoredAgent)
  if (isAgentRefusal(created)) {
    throw new Error(created.error)
  }
  return created
}

async function join(node: Node, mover: StoredAgent, lead: string): Promise<StoredAgent> {
  const joined = await node.teams.join(mover, lead, (j) => node.agents.update(mover.id, { lead }, { joined: j }))
  if (isAgentRefusal(joined)) {
    throw new Error(joined.error)
  }
  return joined
}

async function team(mesh: Mesh) {
  const mac = await mesh.add('mac')
  const win = await mesh.add('win')
  const pi = await mesh.add('pi')
  const lead = await agent(mac, 'AC-Lead')
  const leadId = `mac:${lead.id}`
  const member = await join(win, await agent(win, 'MagWin'), leadId)
  const mate = await join(pi, await agent(pi, 'Tee'), leadId)
  return { mac, win, pi, lead, leadId, member, mate }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(check()).toBe(true)
}

describe('team rosters', () => {
  it('vouches for a teammate on a third gateway only with a fresh roster from the lead that lists it', async () => {
    const mesh = new Mesh()
    const { mac, win, pi, lead, leadId, mate } = await team(mesh)
    const mateClaim = { id: `pi:${mate.id}`, lead: leadId }
    expect(win.agents.vouches(mateClaim, 'pi')).toBe(false)

    await mac.teams.reconcile()
    expect(win.agents.vouches(mateClaim, 'pi')).toBe(true)
    expect(win.agents.vouches({ id: 'pi:stranger', lead: leadId }, 'pi')).toBe(false)
    expect(mac.agents.get(lead.id)?.roster).toMatchObject({ rev: 1 })

    mesh.clock.now += 60_001
    expect(win.agents.vouches(mateClaim, 'pi')).toBe(false)
    await win.teams.reconcile()
    expect(win.agents.vouches(mateClaim, 'pi')).toBe(true)

    expect(
      await pi.agents.update(mate.id, { lead: null }, { onLeadChanged: (prev) => pi.teams.left(mate.id, prev.lead, prev.remoteLead?.op) }),
    ).toMatchObject({ id: mate.id })
    await until(() => (mac.agents.get(lead.id)?.remoteMembers ?? []).length === 1)
    await mac.teams.reconcile()
    expect(mac.agents.get(lead.id)?.roster).toMatchObject({ rev: 2 })
    expect(win.agents.vouches(mateClaim, 'pi')).toBe(false)
  })

  it('keeps a member restricted while its lead is unreachable, and denies its teammates once the roster is stale', async () => {
    const mesh = new Mesh()
    const { mac, win, leadId, member, mate } = await team(mesh)
    await mac.teams.reconcile()
    mesh.down.add('mac')
    mesh.clock.now += 60_001
    await win.teams.reconcile()
    expect(win.agents.get(member.id)).toMatchObject({ lead: leadId, remoteLead: { state: 'unreachable' } })
    expect(win.agents.vouches({ id: `pi:${mate.id}`, lead: leadId }, 'pi')).toBe(false)
  })

  it('pushes a changed roster without waiting for the timer', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add('mac', createMemoryAgentStore(), { soonMs: 1, start: true })
    const win = await mesh.add('win')
    const pi = await mesh.add('pi')
    const lead = await agent(mac, 'AC-Lead')
    const leadId = `mac:${lead.id}`
    await join(win, await agent(win, 'MagWin'), leadId)
    const mate = await join(pi, await agent(pi, 'Tee'), leadId)
    await until(() => win.agents.vouches({ id: `pi:${mate.id}`, lead: leadId }, 'pi'))
  })

  it('takes a higher revision or a new epoch, refuses a lower one, and never goes back to a replaced epoch', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const win = await mesh.add('win')
    const lead = await agent(mac, 'AC-Lead')
    const leadId = `mac:${lead.id}`
    await join(win, await agent(win, 'MagWin'), leadId)
    const vouched = () => win.agents.vouches({ id: 'pi:T', lead: leadId }, 'pi')
    const send = (epoch: string, rev: number, members: string[]) =>
      win.teams.inboundStatus(
        { gateway: 'mac' },
        { edges: [], rosters: [{ lead: leadId, epoch, rev, members: members.map((id) => ({ id })) }] },
      )

    await send('e1', 5, ['pi:T'])
    expect(vouched()).toBe(true)
    await send('e1', 4, [])
    expect(vouched()).toBe(true)
    await send('e1', 6, [])
    expect(vouched()).toBe(false)
    await send('e2', 1, ['pi:T'])
    expect(vouched()).toBe(true)
    await send('e1', 9, [])
    expect(vouched()).toBe(true)
    mesh.clock.now += 60_001
    expect(vouched()).toBe(false)
    await send('e2', 1, ['pi:T'])
    expect(vouched()).toBe(true)
    await win.teams.inboundStatus({ gateway: 'pi' }, { edges: [], rosters: [{ lead: leadId, epoch: 'e3', rev: 1, members: [] }] })
    expect(vouched()).toBe(true)
  })

  it('starts a new epoch when a member gateway has seen a later revision than the lead holds (a restored backup)', async () => {
    const mesh = new Mesh()
    const { mac, win, lead, leadId, mate } = await team(mesh)
    const vouched = () => win.agents.vouches({ id: `pi:${mate.id}`, lead: leadId }, 'pi')
    await mac.teams.reconcile()
    const before = mac.agents.get(lead.id)!.roster!
    await mac.agents.patch(lead.id, (current) => ({ ...current, roster: { ...before, rev: 0 } }))
    mesh.clock.now += 60_001
    await mac.teams.reconcile()
    expect(vouched()).toBe(false)
    const after = mac.agents.get(lead.id)!.roster!
    expect(after).toMatchObject({ rev: 1 })
    expect(after.epoch).not.toBe(before.epoch)
    await mac.teams.reconcile()
    expect(vouched()).toBe(true)
  })

  it('takes a seen revision only from a gateway that hosts a member of that lead', async () => {
    const mesh = new Mesh()
    const { mac, lead, leadId } = await team(mesh)
    await mac.teams.reconcile()
    const before = mac.agents.get(lead.id)!.roster!
    await mac.teams.inboundStatus({ gateway: 'evil' }, { edges: [], seen: [{ lead: leadId, epoch: before.epoch, rev: 99 }] })
    expect(mac.agents.get(lead.id)!.roster).toEqual(before)
  })

  it('follows the lead at an equal revision, so a reissued revision with other members wins', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const win = await mesh.add('win')
    const lead = await agent(mac, 'AC-Lead')
    const leadId = `mac:${lead.id}`
    await join(win, await agent(win, 'MagWin'), leadId)
    const send = (members: string[]) =>
      win.teams.inboundStatus(
        { gateway: 'mac' },
        { edges: [], rosters: [{ lead: leadId, epoch: 'e1', rev: 3, members: members.map((id) => ({ id })) }] },
      )
    await send(['pi:T'])
    await send([])
    expect(win.agents.vouches({ id: 'pi:T', lead: leadId }, 'pi')).toBe(false)
  })
})

describe('member consent', () => {
  it('acts on leave and release only for the join op it holds', async () => {
    const mesh = new Mesh()
    const { mac, win, lead, leadId, member } = await team(mesh)
    const origin = { gateway: 'win', owner: 'tobias', agent: `win:${member.id}`, name: 'MagWin' }
    expect(await mac.teams.inbound('team.leave', origin, lead.id, 'an-earlier-join')).toEqual({ ok: true })
    expect(mac.agents.get(lead.id)?.remoteMembers?.map((entry) => entry.agent)).toContain(`win:${member.id}`)
    const release = { gateway: 'mac', owner: 'tobias', agent: leadId, name: 'AC-Lead' }
    expect(await win.teams.inbound('team.release', release, member.id, 'an-earlier-join')).toEqual({ ok: true })
    expect(win.agents.get(member.id)?.lead).toBe(leadId)
    expect(await win.teams.inbound('team.release', release, member.id, member.remoteLead!.op)).toEqual({ ok: true })
    expect(win.agents.get(member.id)?.lead).toBeUndefined()
  })

  it('a leave takes effect at once, and the lead drops its half on the next status even if the leave frame was lost', async () => {
    const mesh = new Mesh()
    const { mac, win, lead, leadId, member } = await team(mesh)
    await mac.teams.reconcile()
    mesh.dropped.add('team.leave')
    await win.agents.update(
      member.id,
      { lead: null },
      { onLeadChanged: (prev) => win.teams.left(member.id, prev.lead, prev.remoteLead?.op) },
    )
    expect(win.agents.get(member.id)?.lead).toBeUndefined()
    await win.teams.inboundStatus(
      { gateway: 'mac' },
      { edges: [], rosters: [{ lead: leadId, epoch: 'e9', rev: 99, members: [{ id: `win:${member.id}` }] }] },
    )
    expect(win.agents.get(member.id)?.lead).toBeUndefined()
    await mac.teams.reconcile()
    expect(mac.agents.get(lead.id)?.remoteMembers?.some((entry) => entry.agent === `win:${member.id}`)).toBe(false)
  })

  it('refuses a second join while the first is outstanding, and a rejoin replaces the op on the lead', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const win = await mesh.add('win')
    const lead = await agent(mac, 'AC-Lead')
    const other = await agent(mac, 'Other-Lead')
    const mover = await agent(win, 'MagWin')
    const first = win.teams.join(mover, `mac:${lead.id}`, (j) => win.agents.update(mover.id, { lead: `mac:${lead.id}` }, { joined: j }))
    const second = await win.teams.join(mover, `mac:${other.id}`, (j) =>
      win.agents.update(mover.id, { lead: `mac:${other.id}` }, { joined: j }),
    )
    expect(second).toEqual({ status: 409, error: 'MagWin is already joining a team' })
    const joined = (await first) as StoredAgent
    expect(mac.agents.get(lead.id)?.remoteMembers).toMatchObject([
      { agent: `win:${mover.id}`, state: 'accepted', op: joined.remoteLead!.op },
    ])
    expect(win.agents.get(mover.id)?.pendingJoin).toBeUndefined()
  })
})

describe('joins across a restart', () => {
  async function interrupted(lead: 'accepted' | 'unknown') {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const store = createMemoryAgentStore()
    const win = await mesh.add('win', store)
    const leadAgent = await agent(mac, 'AC-Lead')
    const leadId = `mac:${leadAgent.id}`
    const mover = await agent(win, 'MagWin')
    const reserved = await win.agents.reserveJoin(mover, leadId)
    if (isAgentRefusal(reserved)) {
      throw new Error(reserved.error)
    }
    if (lead === 'accepted') {
      await mac.teams.inbound(
        'team.join',
        { gateway: 'win', owner: 'tobias', agent: `win:${mover.id}`, name: 'MagWin' },
        leadAgent.id,
        reserved.op,
      )
    }
    await win.agents.close()
    const restarted = await mesh.add('win', store)
    return { mesh, mac, restarted, leadAgent, leadId, mover, op: reserved.op }
  }

  it('persists the reservation and commits it when the lead had accepted', async () => {
    const { mac, restarted, leadAgent, leadId, mover, op } = await interrupted('accepted')
    expect(restarted.agents.get(mover.id)?.pendingJoin).toMatchObject({ op, lead: leadId })
    expect((await restarted.teams.inboundStatus({ gateway: 'mac' }, { edges: [{ from: leadId, to: mover.id, op }] })).edges).toEqual([
      { known: true, name: 'MagWin', owner: 'tobias' },
    ])
    const refused = await restarted.teams.join(mover, leadId, (j) => restarted.agents.update(mover.id, { lead: leadId }, { joined: j }))
    expect(refused).toEqual({ status: 409, error: 'MagWin is already joining a team' })
    await restarted.teams.reconcile()
    expect(restarted.agents.get(mover.id)).toMatchObject({ lead: leadId, remoteLead: { op, state: 'joined', name: 'AC-Lead', owner: 'tobias' } })
    expect(restarted.agents.get(mover.id)?.pendingJoin).toBeUndefined()
    expect(restarted.agents.restoredJoins()).toEqual([])
    expect(mac.agents.get(leadAgent.id)?.remoteMembers).toMatchObject([{ state: 'accepted', op }])
  })

  it('drops the reservation when the lead does not know the join, and keeps it while the lead is unreachable', async () => {
    const { mesh, restarted, mover } = await interrupted('unknown')
    mesh.down.add('mac')
    await restarted.teams.reconcile()
    expect(restarted.agents.get(mover.id)?.pendingJoin).toBeDefined()
    mesh.down.delete('mac')
    await restarted.teams.reconcile()
    expect(restarted.agents.get(mover.id)?.pendingJoin).toBeUndefined()
    expect(restarted.agents.get(mover.id)?.lead).toBeUndefined()
    expect(restarted.agents.restoredJoins()).toEqual([])
  })
})

describe('restart edge cases', () => {
  async function rejoining(macHolds: 'old' | 'new') {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const lead = await agent(mac, 'AC-Lead')
    const leadId = `mac:${lead.id}`
    const origin = { gateway: 'win', owner: 'tobias', agent: 'win:M', name: 'M' }
    await mac.teams.inbound('team.join', origin, lead.id, macHolds === 'old' ? 'op-old' : 'op-new')
    const store = createMemoryAgentStore([
      {
        id: 'M',
        name: 'M',
        schema: 2,
        createdAt: 1,
        updatedAt: 1,
        avatarSeed: 'M',
        pastSessions: [],
        config: {},
        lead: leadId,
        remoteLead: { name: 'AC-Lead', state: 'joined', since: 1, op: 'op-old' },
        pendingJoin: { op: 'op-new', lead: leadId, at: 1 },
      },
    ])
    const win = await mesh.add('win', store)
    await win.teams.reconcile()
    return win.agents.get('M')!
  }

  it('matches each status answer to its op, so a rejoin interrupted by a restart commits only what the lead accepted', async () => {
    const committed = await rejoining('new')
    expect(committed.remoteLead?.op).toBe('op-new')
    expect(committed.pendingJoin).toBeUndefined()
    const kept = await rejoining('old')
    expect(kept.remoteLead?.op).toBe('op-old')
    expect(kept.pendingJoin).toBeUndefined()
  })

  it('cancels a pending join with lead null, withdraws the acceptance and never recommits it', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const store = createMemoryAgentStore()
    const first = await mesh.add('win', store)
    const lead = await agent(mac, 'AC-Lead')
    const mover = await agent(first, 'MagWin')
    const reserved = (await first.agents.reserveJoin(mover, `mac:${lead.id}`)) as { op: string }
    await mac.teams.inbound(
      'team.join',
      { gateway: 'win', owner: 'tobias', agent: `win:${mover.id}`, name: 'MagWin' },
      lead.id,
      reserved.op,
    )
    await first.agents.close()
    const win = await mesh.add('win', store)
    const cancelled = await win.agents.update(mover.id, { lead: null }, { onJoinCancelled: (to, op) => win.teams.left(mover.id, to, op) })
    expect(cancelled).toMatchObject({ id: mover.id })
    expect(win.agents.get(mover.id)?.pendingJoin).toBeUndefined()
    expect(win.agents.restoredJoins()).toEqual([])
    await until(() => (mac.agents.get(lead.id)?.remoteMembers ?? []).length === 0)
    await win.teams.reconcile()
    expect(win.agents.get(mover.id)?.lead).toBeUndefined()
  })
})

describe('schema 2 migration', () => {
  const base = (id: string, extra: Partial<StoredAgent> = {}): StoredAgent => ({
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    avatarSeed: id,
    pastSessions: [],
    config: {},
    ...extra,
  })

  it('classifies the stored halves deterministically and idempotently', () => {
    const member = base('M', { lead: 'mac:L', remoteLead: { name: 'AC-Lead', state: 'joined', since: 5 } })
    const lead = base('L', {
      remoteMembers: [
        { agent: 'pi:T', state: 'accepted', at: 1 },
        { agent: 'pi:I', state: 'invited', at: 1, expiresAt: 9 },
      ],
    })
    const moved = base('X', { lead: 'Y', remoteLead: { name: 'Old', state: 'joined', since: 1 } })
    const pending = base('P', { pendingJoin: { op: 'o', lead: 'win:Q', at: 1 } })

    expect(normalizeAgent(member, 'win', 7)).toMatchObject({
      schema: 2,
      lead: 'mac:L',
      remoteLead: { name: 'AC-Lead', state: 'unconfirmed', since: 5, op: legacyOp('mac:L', 'win:M') },
    })
    expect(normalizeAgent(lead, 'mac', 7).remoteMembers).toEqual([
      { agent: 'pi:T', state: 'unconfirmed', at: 1, op: legacyOp('mac:L', 'pi:T') },
      { agent: 'pi:I', state: 'invited', at: 1, expiresAt: 9 },
    ])
    expect(normalizeAgent(moved, 'win', 7).remoteLead).toBeUndefined()
    expect(normalizeAgent(pending, 'win', 7).pendingJoin).toBeUndefined()
    const once = normalizeAgent(member, 'win', 7)
    expect(normalizeAgent(once, 'win', 99)).toBe(once)
  })

  it('confirms matching halves on the first status exchange and dissolves a one-sided one, widening nothing before', async () => {
    const mesh = new Mesh()
    const macStore = createMemoryAgentStore([base('L', { remoteMembers: [{ agent: 'win:M', state: 'accepted', at: 1 }] })])
    const winStore = createMemoryAgentStore([
      base('M', { lead: 'mac:L', remoteLead: { name: 'L', state: 'joined', since: 1 } }),
      base('O', { lead: 'mac:L', remoteLead: { name: 'L', state: 'joined', since: 1 } }),
    ])
    const mac = await mesh.add('mac', macStore)
    const win = await mesh.add('win', winStore)
    expect(mac.agents.get('L')?.remoteMembers?.[0]?.state).toBe('unconfirmed')
    expect(mac.agents.vouches({ id: 'win:M', lead: 'mac:L' }, 'win')).toBe(false)
    expect(mac.agents.relayAgent('none')).toBeUndefined()
    expect((await winStore.list()).every((record) => record.schema === 2)).toBe(true)

    await win.teams.reconcile()
    expect(win.agents.get('M')?.remoteLead).toMatchObject({ state: 'joined', op: legacyOp('mac:L', 'win:M') })
    expect(mac.agents.get('L')?.remoteMembers).toMatchObject([{ agent: 'win:M', state: 'accepted' }])
    expect(mac.agents.vouches({ id: 'win:M', lead: 'mac:L' }, 'win')).toBe(true)
    expect(win.agents.get('O')?.lead).toBeUndefined()
  })

  it('never confirms a migrated edge whose member also leads, whichever side asks, and releases it when the lead drops it', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add(
      'mac',
      createMemoryAgentStore([base('L', { remoteMembers: [{ agent: 'win:M', state: 'accepted', at: 1 }] })]),
    )
    const win = await mesh.add(
      'win',
      createMemoryAgentStore([
        base('M', { lead: 'mac:L', remoteLead: { name: 'L', state: 'joined', since: 1 } }),
        base('C', { lead: 'M' }),
      ]),
    )
    await win.teams.reconcile()
    expect(win.agents.get('M')?.remoteLead?.state).toBe('unconfirmed')
    expect(mac.agents.get('L')?.remoteMembers?.[0]?.state).toBe('unconfirmed')
    expect(mac.agents.vouches({ id: 'win:M', lead: 'mac:L' }, 'win')).toBe(false)
    await mac.teams.reconcile()
    expect(mac.agents.get('L')?.remoteMembers).toEqual([])
    await until(() => win.agents.get('M')?.lead === undefined)
  })

  it('loads a record from a newer schema but never writes, publishes or reconciles it', async () => {
    const mesh = new Mesh()
    const future = base('F', { schema: 3, sessionId: 's-f', lead: 'mac:L', remoteLead: { name: 'L', state: 'joined', since: 1 } })
    const store = createMemoryAgentStore([future])
    let writes = 0
    const counting: AgentStore = { ...store, apply: (changes) => (writes++, store.apply!(changes)) }
    const win = await mesh.add('win', counting)
    expect(writes).toBe(0)
    expect(win.agents.get('F')).toEqual(future)
    expect(await win.agents.update('F', { name: 'Renamed' })).toEqual({
      status: 409,
      error: 'F was written by a newer WorkerDeck; this one leaves it as it is',
    })
    expect(win.agents.relayAgent('s-f')).toBeUndefined()
    await win.teams.reconcile()
    expect(writes).toBe(0)
    expect(win.agents.get('F')).toEqual(future)
  })
})

describe('second review', () => {
  const record = (id: string, extra: Partial<StoredAgent> = {}): StoredAgent => ({
    id,
    name: id,
    schema: 2,
    createdAt: 1,
    updatedAt: 1,
    avatarSeed: id,
    pastSessions: [],
    config: {},
    ...extra,
  })

  it('gives no answer and accepts no frame before its store is loaded', async () => {
    const agents = new AgentService({ store: createMemoryAgentStore([record('M', { lead: 'mac:L' })]), basePath: '/v1', gateway: 'win' })
    const teams = new TeamLinks({ agents, transport: new Mesh().transport('win') })
    expect((await teams.inboundStatus({ gateway: 'mac' }, { edges: [{ from: 'mac:L', to: 'M', op: 'o' }] })).edges).toEqual([{}])
    expect(await teams.inbound('team.release', { gateway: 'mac', owner: 'tobias', agent: 'mac:L' }, 'M', 'o')).toEqual({
      ok: false,
      reason: 'that gateway is starting; try again shortly',
    })
  })

  it('answers for the binding it holds while a rejoin to the same lead is pending under another op', async () => {
    const mesh = new Mesh()
    const store = createMemoryAgentStore([
      record('M', {
        lead: 'mac:L',
        remoteLead: { name: 'L', state: 'joined', since: 1, op: 'op-old' },
        pendingJoin: { op: 'op-new', lead: 'mac:L', at: 1 },
      }),
    ])
    const win = await mesh.add('win', store)
    const ask = async (op: string) => (await win.teams.inboundStatus({ gateway: 'mac' }, { edges: [{ from: 'mac:L', to: 'M', op }] })).edges
    expect(await ask('op-old')).toEqual([{ known: true, name: 'M', owner: 'tobias' }])
    expect(await ask('op-new')).toEqual([{ known: true, name: 'M', owner: 'tobias' }])
    expect(await ask('op-other')).toEqual([{ known: false }])
  })

  it('keeps the reservation when a cancelling patch is refused', async () => {
    const mesh = new Mesh()
    const win = await mesh.add('win')
    const mover = await agent(win, 'M')
    await win.agents.reserveJoin(mover, 'mac:L')
    expect(await win.agents.update(mover.id, { lead: null, order: 'x' as unknown as number })).toEqual({
      status: 400,
      error: 'order must be a number',
    })
    expect(win.agents.joiningLead(mover.id)).toBe('mac:L')
  })

  it('takes a replaced epoch back once the cached roster is stale (a second restore)', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add('mac')
    const win = await mesh.add('win')
    const lead = await agent(mac, 'L')
    const leadId = `mac:${lead.id}`
    await join(win, await agent(win, 'M'), leadId)
    const send = (epoch: string) =>
      win.teams.inboundStatus({ gateway: 'mac' }, { edges: [], rosters: [{ lead: leadId, epoch, rev: 1, members: [{ id: 'pi:T' }] }] })
    await send('e1')
    await send('e2')
    await send('e1')
    mesh.clock.now += 60_001
    expect(win.agents.vouches({ id: 'pi:T', lead: leadId }, 'pi')).toBe(false)
    await send('e1')
    expect(win.agents.vouches({ id: 'pi:T', lead: leadId }, 'pi')).toBe(true)
  })

  it('refuses a lead with unconfirmed members joining a local lead too', async () => {
    const mesh = new Mesh()
    const mac = await mesh.add(
      'mac',
      createMemoryAgentStore([record('L', { remoteMembers: [{ agent: 'win:M', state: 'accepted', at: 1 }] }), record('K')]),
    )
    expect(await mac.agents.update('L', { lead: 'K' })).toEqual({ status: 409, error: 'L has team members waiting to be confirmed' })
  })

  it('restores no join reservation without a relay gateway name', async () => {
    const agents = new AgentService({
      store: createMemoryAgentStore([record('M', { pendingJoin: { op: 'o', lead: 'mac:L', at: 1 } })]),
      basePath: '/v1',
    })
    await agents.hydrate()
    expect(agents.restoredJoins()).toEqual([])
    expect(agents.joiningLead('M')).toBeUndefined()
  })
})
