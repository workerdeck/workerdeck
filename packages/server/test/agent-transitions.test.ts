import { describe, expect, it } from 'vitest'
import type { TeamFrameKind, TeamResult, TeamStatusAnswer } from '@workerdeck/relay-client'
import { createMemoryAgentStore, type AgentStore, type StoredAgent } from '../src/services/agent-store.ts'
import { AgentService, isAgentRefusal } from '../src/services/agents.ts'
import { TeamLinks, type TeamTransport } from '../src/services/team-links.ts'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

type Frame = { kind: TeamFrameKind; from: string; to: string; op?: string }

function heldTransport(): TeamTransport & { frames: Frame[]; held: Deferred<TeamResult> } {
  const transport = {
    gateway: 'win',
    frames: [] as Frame[],
    held: deferred<TeamResult>(),
    ready: () => undefined,
    owner: () => 'tobias',
    team: (kind: TeamFrameKind, from: string, to: string, op?: string): Promise<TeamResult> => {
      transport.frames.push({ kind, from, to, op })
      return kind === 'team.join' ? transport.held.promise : Promise.resolve({ ok: true })
    },
    teamStatus: async (): Promise<TeamStatusAnswer> => ({ edges: [] }),
    nudge: () => {},
  }
  return transport
}

async function service(store: AgentStore = createMemoryAgentStore()): Promise<AgentService> {
  const agents = new AgentService({ store, basePath: '/v1', gateway: 'win' })
  await agents.hydrate()
  return agents
}

async function stored(agents: AgentService, name: string, extra: Partial<StoredAgent> = {}): Promise<StoredAgent> {
  const created = await agents.create({ ...(agents.draft({ name }) as StoredAgent), ...extra })
  if (isAgentRefusal(created)) {
    throw new Error(created.error)
  }
  return created
}

async function joinRig() {
  const agents = await service()
  const transport = heldTransport()
  const teams = new TeamLinks({ agents, transport })
  const mover = await stored(agents, 'Scout')
  const joining = teams.join(mover, 'mac:L1', (joined) => agents.update(mover.id, { lead: 'mac:L1' }, { joined }))
  await until(() => transport.frames.length > 0)
  return { agents, transport, teams, mover, joining }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(check()).toBe(true)
}

describe('agent mutation transitions', () => {
  it('refuses the second of two concurrent moves that would form a cycle', async () => {
    const agents = await service()
    const a = await stored(agents, 'A')
    const b = await stored(agents, 'B')
    const [first, second] = await Promise.all([agents.update(a.id, { lead: b.id }), agents.update(b.id, { lead: a.id })])
    expect(first).toMatchObject({ lead: b.id })
    expect(second).toEqual({ status: 409, error: 'A is a member of a team; teams are one level deep' })
    expect(agents.get(b.id)?.lead).toBeUndefined()
  })

  it('refuses a local child under an agent while it joins a remote team, and commits the join', async () => {
    const { agents, transport, mover, joining } = await joinRig()
    const child = agents.draft({ name: 'Child' }) as StoredAgent
    expect(await agents.create({ ...child, lead: mover.id })).toEqual({ status: 409, error: 'Scout is joining a team' })
    expect(await agents.update((await stored(agents, 'Other')).id, { lead: mover.id })).toEqual({
      status: 409,
      error: 'Scout is joining a team',
    })
    transport.held.resolve({ ok: true, leadName: 'AC-Lead' })
    expect(await joining).toMatchObject({ lead: 'mac:L1', remoteLead: { name: 'AC-Lead' } })
    expect(agents.members(mover.id)).toEqual([])
  })

  it('cancels a join in flight with lead null: the late acceptance is refused and withdrawn', async () => {
    const { agents, transport, mover, joining } = await joinRig()
    const cancelled: string[] = []
    expect(await agents.update(mover.id, { lead: null }, { onJoinCancelled: (_lead, op) => cancelled.push(op) })).toMatchObject({
      id: mover.id,
    })
    const op = transport.frames[0]!.op!
    expect(cancelled).toEqual([op])
    transport.held.resolve({ ok: true, leadName: 'AC-Lead' })
    expect(await joining).toEqual({ status: 409, error: 'a lead on another gateway is joined through the relay' })
    expect(agents.get(mover.id)?.lead).toBeUndefined()
    expect(transport.frames.at(-1)).toEqual({ kind: 'team.leave', from: mover.id, to: 'mac:L1', op })
  })

  it('withdraws the lead acceptance when the agent retires mid-join, and never revives it', async () => {
    const { agents, transport, mover, joining } = await joinRig()
    expect(await agents.retire(mover.id, 'release')).toMatchObject({ retired: [{ id: mover.id }] })
    transport.held.resolve({ ok: true, leadName: 'AC-Lead' })
    expect(await joining).toEqual({ status: 404, error: `no such agent: ${mover.id}` })
    expect(agents.get(mover.id)).toBeUndefined()
    expect(transport.frames.at(-1)).toEqual({ kind: 'team.leave', from: mover.id, to: 'mac:L1', op: transport.frames[0]!.op })
    expect(await agents.create(mover)).toEqual({ status: 409, error: `agent ${mover.id} already exists` })
    expect(await agents.bind(mover.id, 'session-1')).toEqual({ status: 404, error: `no such agent: ${mover.id}` })
  })

  it('answers known for an unsaved draft while its join is outstanding', async () => {
    const agents = await service()
    const transport = heldTransport()
    const teams = new TeamLinks({ agents, transport })
    const draft = agents.draft({ name: 'Draft' }) as StoredAgent
    const joining = teams.join(draft, 'mac:L1', (joined) => agents.create(draft, joined))
    await until(() => transport.frames.length > 0)
    const op = transport.frames[0]!.op
    const ask = async (from: string, asked = op) =>
      (await teams.inboundStatus({ gateway: 'mac' }, { edges: [{ from, to: draft.id, op: asked }] })).edges
    expect(await ask('mac:L1')).toEqual([{ known: true, name: 'Draft' }])
    expect(await ask('mac:L2')).toEqual([{ known: false }])
    expect(await ask('mac:L1', 'another-join')).toEqual([{ known: false }])
    transport.held.resolve({ ok: true, leadName: 'AC-Lead' })
    expect(await joining).toMatchObject({ id: draft.id, lead: 'mac:L1', remoteLead: { op } })
    expect(await ask('mac:L1')).toEqual([{ known: true, name: 'Draft' }])
  })

  it('refuses an inbound join and an invitation to an agent that is joining', async () => {
    const { teams, transport, mover, joining } = await joinRig()
    const origin = { gateway: 'mac', owner: 'tobias', agent: 'mac:X', name: 'X' }
    expect(await teams.inbound('team.join', origin, mover.id, 'op-1')).toEqual({ ok: false, reason: 'Scout is joining a team' })
    expect(await teams.invite(mover, 'mac:X')).toEqual({ status: 409, error: 'Scout is joining a team' })
    transport.held.resolve({ ok: true, leadName: 'AC-Lead' })
    await joining
  })

  it('binds one session to one agent under concurrent adoption', async () => {
    const agents = await service()
    const results = await Promise.all([
      agents.create({ ...(agents.draft({ name: 'One' }) as StoredAgent), sessionId: 's-1' }),
      agents.create({ ...(agents.draft({ name: 'Two' }) as StoredAgent), sessionId: 's-1' }),
    ])
    expect(results.filter(isAgentRefusal)).toEqual([{ status: 409, error: 'that session already belongs to an agent' }])
    const other = await stored(agents, 'Three')
    expect(await agents.bind(other.id, 's-1')).toEqual({ status: 409, error: 'that session already belongs to an agent' })
  })

  it('patches the current record, so a write prepared before a move keeps the move', async () => {
    const agents = await service()
    const lead = await stored(agents, 'Lead')
    const member = await stored(agents, 'Member')
    const recipe = deferred<unknown>()
    const avatar = recipe.promise.then((rolled) =>
      agents.patch(member.id, (current) => ({ ...current, avatarSeed: 'otter', avatarRecipe: rolled })),
    )
    await agents.update(member.id, { lead: lead.id })
    recipe.resolve({ seed: 'otter' })
    expect(await avatar).toMatchObject({ lead: lead.id, avatarSeed: 'otter' })
    expect(await agents.bind(member.id, 's-9', { seed: 'late' })).toMatchObject({ lead: lead.id, avatarRecipe: { seed: 'otter' } })
  })

  it('leaves the graph untouched when the store fails, and keeps serving later writes', async () => {
    const store = createMemoryAgentStore()
    let failing = false
    const flaky: AgentStore = {
      ...store,
      apply: async (changes) => {
        if (failing) {
          throw new Error('disk full')
        }
        await store.apply!(changes)
      },
    }
    const agents = await service(flaky)
    const a = await stored(agents, 'A')
    failing = true
    await expect(agents.update(a.id, { name: 'Renamed' })).rejects.toThrow('disk full')
    expect(agents.get(a.id)?.name).toBe('A')
    failing = false
    expect(await agents.update(a.id, { name: 'Renamed' })).toMatchObject({ name: 'Renamed' })
  })

  it('writes a retire with its released members as one store change', async () => {
    const store = createMemoryAgentStore()
    const applied: Array<{ saves: string[]; deletes: string[] }> = []
    const counting: AgentStore = {
      ...store,
      apply: (changes) => {
        applied.push({ saves: changes.saves.map((a) => a.name), deletes: changes.deletes })
        return store.apply!(changes)
      },
    }
    const agents = await service(counting)
    const lead = await stored(agents, 'Lead')
    await agents.update((await stored(agents, 'M1')).id, { lead: lead.id })
    await agents.update((await stored(agents, 'M2')).id, { lead: lead.id })
    applied.length = 0
    await agents.retire(lead.id, 'release')
    expect(applied).toEqual([{ saves: ['M1', 'M2'], deletes: [lead.id] }])
    expect((await store.list()).map((a) => [a.name, a.lead])).toEqual([
      ['M1', undefined],
      ['M2', undefined],
    ])
  })

  it("lets the next generation hydrate only after the old one's active write has landed", async () => {
    const backing = createMemoryAgentStore()
    const gate = deferred<void>()
    let held = false
    let entered = 0
    const store: AgentStore = {
      ...backing,
      apply: async (changes) => {
        if (held) {
          entered++
          await gate.promise
        }
        await backing.apply!(changes)
      },
    }
    const old = await service(store)
    const agent = await stored(old, 'Atlas')
    held = true
    const oldWrite = old.update(agent.id, { name: 'Old write' })
    await until(() => entered === 1)
    let closed = false
    const closing = old.close().then(() => (closed = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(closed).toBe(false)
    gate.resolve()
    await closing
    expect(await oldWrite).toMatchObject({ name: 'Old write' })
    held = false
    const next = await service(store)
    expect(await next.update(agent.id, { name: 'New generation' })).toMatchObject({ name: 'New generation' })
    expect((await backing.list()).map((a) => a.name)).toEqual(['New generation'])
  })

  it('fails a retire closed on a store without apply: a member left behind keeps its lead', async () => {
    const backing = createMemoryAgentStore()
    const legacy: AgentStore = {
      list: backing.list,
      save: backing.save,
      delete: () => {
        throw new Error('disk full')
      },
    }
    const agents = await service(legacy)
    const lead = await stored(agents, 'Lead')
    const member = await stored(agents, 'Member')
    await agents.update(member.id, { lead: lead.id })
    await expect(agents.retire(lead.id, 'release')).rejects.toThrow('disk full')
    expect((await backing.list()).find((a) => a.id === member.id)?.lead).toBe(lead.id)
    expect(agents.get(member.id)?.lead).toBe(lead.id)
  })

  it('ends a reconcile quietly when the generation stops while a status answer is outstanding', async () => {
    const agents = await service()
    const transport = heldTransport()
    const status = deferred<TeamStatusAnswer>()
    transport.teamStatus = () => status.promise
    const logged: string[] = []
    const teams = new TeamLinks({ agents, transport, log: (line) => logged.push(line) })
    const mover = await stored(agents, 'Scout')
    const joining = teams.join(mover, 'mac:L1', (joined) => agents.update(mover.id, { lead: 'mac:L1' }, { joined }))
    transport.held.resolve({ ok: true, leadName: 'AC-Lead' })
    await joining
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const pass = teams.reconcile()
      await until(() => transport.frames.length > 0)
      teams.stop()
      await agents.close()
      status.resolve({ edges: [] })
      await pass
      await new Promise((resolve) => setTimeout(resolve, 5))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(logged).toEqual([])
  })

  it('refuses every write once its generation has closed, including one already queued', async () => {
    const store = createMemoryAgentStore()
    const gate = deferred<void>()
    let writing = 0
    const slow: AgentStore = {
      ...store,
      apply: async (changes) => {
        writing++
        await gate.promise
        await store.apply!(changes)
      },
    }
    const agents = await service(slow)
    const first = agents.create(agents.draft({ name: 'First' }) as StoredAgent)
    const queued = agents.create(agents.draft({ name: 'Queued' }) as StoredAgent)
    await until(() => writing === 1)
    agents.close()
    gate.resolve()
    expect(await first).toMatchObject({ name: 'First' })
    await expect(queued).rejects.toThrow('agent store is closed')
    expect((await store.list()).map((a) => a.name)).toEqual(['First'])
  })
})

describe('remote team claims', () => {
  it('vouches for a member of a lead here only with that lead accepted entry, and checks the id names its gateway', async () => {
    const agents = await service()
    const transport = heldTransport()
    const teams = new TeamLinks({ agents, transport, acceptFrom: ['mac'], owners: { defaultOwner: () => 'tobias' } })
    const lead = await stored(agents, 'Lead')
    await teams.inbound('team.join', { gateway: 'mac', owner: 'tobias', agent: 'mac:M1', name: 'M1' }, lead.id, 'op-1')
    const local = `win:${lead.id}`
    expect(agents.vouches({ id: 'mac:M1', lead: local }, 'mac')).toBe(true)
    expect(agents.vouches({ id: 'mac:M1', lead: local }, 'mac', 'tobias')).toBe(true)
    expect(agents.vouches({ id: 'mac:M1', lead: local }, 'mac', 'ruli')).toBe(false)
    expect(agents.vouches({ id: 'mac:M2', lead: local }, 'mac')).toBe(false)
    expect(agents.vouches({ id: 'mac:M1', lead: local }, 'evil')).toBe(false)
    expect(agents.vouches({ id: `win:${lead.id}` }, 'win')).toBe(false)
    expect(agents.vouches({ id: 'pi:X', lead: 'mac:L9' }, 'pi')).toBe(false)
    expect(agents.vouches({ id: 'pi:X' }, 'pi')).toBe(true)
  })
})
