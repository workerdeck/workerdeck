import { describe, expect, it } from 'vitest'
import { runPeerTool } from '@workerdeck/core'
import { peerDeliveredTo, type AgentRef, type PeerSessionSummary, type SessionInfo } from '@workerdeck/protocol'
import { ProjectInfoService } from '../src/services/project-info.ts'
import { SessionRegistry } from '../src/services/registry.ts'
import { createPeerService, mentionsFor, resolvePeerMentions } from '../src/services/peers.ts'
import type { LateBoundRefs } from '../src/options.ts'
import { PeerRunner } from './peer-runner.ts'
import { eventually } from './helpers.ts'

function rig(options?: { perMinute?: number; maxHops?: number; maxMessageChars?: number }) {
  const registry = new SessionRegistry()
  const refs: LateBoundRefs = { registry }
  const service = createPeerService({ refs, projects: new ProjectInfoService(), options })
  registry.observe((runner) => service.watch(runner))
  const add = (runner: PeerRunner) => {
    registry.register(runner)
    return runner
  }
  return { registry, service, add }
}

describe('peer service: visibility', () => {
  it("lists every other session the sender's scope can see, never itself", async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { scope: { tenant: 't1' } }))
    add(new PeerRunner('b', { scope: { tenant: 't1' }, title: 'Fix auth' }))
    add(new PeerRunner('c', { scope: { tenant: 't2' } }))
    add(new PeerRunner('d'))
    expect((await service.list('a')).map((row) => row.id)).toEqual(['b'])
    expect((await service.list('d')).map((row) => row.id).sort()).toEqual(['a', 'b', 'c'])
    expect((await service.list('a'))[0]).toMatchObject({ id: 'b', title: 'Fix auth', engine: 'claude', status: 'idle' })
  })

  it('peek and send answer "no such session" for a peer outside the sender\'s scope', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { scope: { tenant: 't1' } }))
    const c = add(new PeerRunner('c', { scope: { tenant: 't2' } }))
    expect(await service.peek('a', 'c')).toBeUndefined()
    expect(await service.send('a', 'c', 'hi')).toEqual({ delivered: false, reason: 'no such session: c' })
    expect(c.sent).toEqual([])
  })

  it('refuses an unknown sender outright', async () => {
    const { service } = rig()
    await expect(service.list('ghost')).rejects.toThrow('unknown sender session: ghost')
  })
})

describe('peer service: peek', () => {
  it('reads status, pending approvals and the recent transcript without touching the runner', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a'))
    const b = add(new PeerRunner('b', { status: 'awaiting_approval' }))
    b.emit({ type: 'user_message', message: { role: 'user', content: 'ship it' }, parentToolUseId: null })
    b.emit({
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'running tests' }] },
      parentToolUseId: null,
      uuid: 'x',
    })
    b.pendingApprovals = [{ id: 'p1', toolName: 'Bash', input: {}, toolUseId: 't1', title: 'Run pnpm test' }]
    const peek = await service.peek('a', 'b')
    expect(peek).toMatchObject({ id: 'b', live: true, status: 'awaiting_approval', pendingApprovals: ['Run pnpm test'] })
    expect(peek!.recent).toEqual(['user: ship it', 'assistant: running tests'])
    expect((await service.peek('a', 'b', { recent: 1 }))!.recent).toEqual(['assistant: running tests'])
    expect((await service.peek('a', 'b', { recent: 0 }))!.recent).toEqual([])
    expect(b.sent).toEqual([])
  })
})

describe('peer service: send', () => {
  it('delivers through sendMessage with a peer origin naming the sender, and says whether the peer was busy', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { title: 'Auth fix' }))
    const b = add(new PeerRunner('b'))
    expect(await service.send('a', 'b', 'hello')).toEqual({ delivered: true, sessionId: 'b', queued: false })
    expect(b.sent).toEqual([
      { text: 'hello', options: { origin: { kind: 'peer', sessionId: 'a', name: 'Auth fix', engine: 'claude', hops: ['a'] } } },
    ])
    b.status = 'running'
    expect(await service.send('a', 'b', 'more')).toMatchObject({ delivered: true, queued: true })
  })

  it("names the target so the sender's transcript can draw the peer, not an id", async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { title: 'Alpha' }))
    add(new PeerRunner('b', { title: 'Beta' }))
    const result = await service.send('a', 'b', 'hello')
    expect(result).toMatchObject({ delivered: true, sessionId: 'b', name: 'Beta' })
    const spoken = await runPeerTool(service, 'a', 'peers_send', { sessionId: 'b', text: 'hello' })
    expect(peerDeliveredTo(spoken.text)).toEqual({ sessionId: 'b', name: 'Beta' })
  })

  it("names an agent's session by its agent name, not its session title", async () => {
    const registry = new SessionRegistry()
    const agent: AgentRef = { id: 'B', name: 'Box-Lead' }
    const service = createPeerService({
      refs: { registry },
      projects: new ProjectInfoService({ decorate: (info) => (info.id === 'b' ? { ...info, agent } : info) }),
    })
    registry.register(new PeerRunner('a', { title: 'Alpha' }))
    registry.register(new PeerRunner('b', { title: '1. we do trust the relay' }))
    expect(await service.send('a', 'b', 'hello')).toMatchObject({ delivered: true, sessionId: 'b', name: 'Box-Lead' })
  })

  it('refuses self, oversize and closed targets, and reports a runner that throws', async () => {
    const { service, add } = rig({ maxMessageChars: 10 })
    add(new PeerRunner('a'))
    const b = add(new PeerRunner('b'))
    expect(await service.send('a', 'a', 'hi')).toMatchObject({ delivered: false, reason: expect.stringContaining('this session') })
    expect(await service.send('a', 'b', 'x'.repeat(11))).toMatchObject({ delivered: false, reason: expect.stringContaining('limit is 10') })
    b.status = 'closed'
    expect(await service.send('a', 'b', 'hi')).toEqual({ delivered: false, reason: 'session b is closed' })
    b.status = 'idle'
    b.sendMessage = () => {
      throw new Error('session is parked')
    }
    expect(await service.send('a', 'b', 'hi')).toEqual({ delivered: false, reason: 'session is parked' })
  })

  it('rate-limits one sender to one target per minute', async () => {
    const { service, add } = rig({ perMinute: 2 })
    add(new PeerRunner('a'))
    add(new PeerRunner('b'))
    add(new PeerRunner('c'))
    expect((await service.send('a', 'b', '1')).delivered).toBe(true)
    expect((await service.send('a', 'b', '2')).delivered).toBe(true)
    expect(await service.send('a', 'b', '3')).toMatchObject({ delivered: false, reason: expect.stringContaining('rate limit') })
    expect((await service.send('a', 'c', '4')).delivered).toBe(true)
  })

  it('bounds an agent-to-agent exchange by hops, and a human turn resets the chain', async () => {
    const { service, add } = rig({ maxHops: 3, perMinute: 100 })
    const a = add(new PeerRunner('a'))
    const b = add(new PeerRunner('b'))
    expect((await service.send('a', 'b', '1')).delivered).toBe(true)
    expect(b.sent.at(-1)!.options!.origin!.hops).toEqual(['a'])
    expect((await service.send('b', 'a', '2')).delivered).toBe(true)
    expect(a.sent.at(-1)!.options!.origin!.hops).toEqual(['a', 'b'])
    expect((await service.send('a', 'b', '3')).delivered).toBe(true)
    expect(b.sent.at(-1)!.options!.origin!.hops).toEqual(['a', 'b', 'a'])
    expect(await service.send('b', 'a', '4')).toMatchObject({ delivered: false, reason: expect.stringContaining('without a person') })

    b.emit({ type: 'user_message', message: { role: 'user', content: 'carry on' }, parentToolUseId: null })
    expect((await service.send('b', 'a', '5')).delivered).toBe(true)
    expect(a.sent.at(-1)!.options!.origin!.hops).toEqual(['b'])
  })

  it('wakes a dormant target through parking when one is wired', async () => {
    const registry = new SessionRegistry()
    const dormant = new PeerRunner('d')
    const info: SessionInfo = { ...dormant.info(), status: 'parked' }
    const refs: LateBoundRefs = {
      registry,
      parking: {
        listInfo: async () => [info],
        get: async (id: string) => (id === 'd' ? { id, info } : null),
        ensureLive: async (id: string) => (id === 'd' ? (registry.register(dormant), dormant) : registry.get(id)),
      } as unknown as LateBoundRefs['parking'],
    }
    const service = createPeerService({ refs, projects: new ProjectInfoService() })
    registry.register(new PeerRunner('a'))
    expect((await service.list('a')).map((row) => row.id)).toEqual(['d'])
    expect(await service.peek('a', 'd')).toMatchObject({ id: 'd', live: false, recent: [] })
    expect(await service.send('a', 'd', 'wake up')).toEqual({ delivered: true, sessionId: 'd', queued: false })
    expect(dormant.sent).toEqual([
      { text: 'wake up', options: { origin: { kind: 'peer', sessionId: 'a', engine: 'claude', hops: ['a'] } } },
    ])
  })
})

describe('peer service: `#` mentions', () => {
  it('resolves a name the sender can see, folding case and separators', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a'))
    add(new PeerRunner('b', { title: 'Astra' }))
    add(new PeerRunner('c', { title: 'Fix login bug' }))
    const mentions = resolvePeerMentions(await service.list('a'), 'commit what #astra did, then ask #Fix-login-bug')
    expect(mentions.map((m) => m.id)).toEqual(['b', 'c'])
    expect(mentions[0]).toMatchObject({ typed: 'astra', id: 'b', name: 'Astra', engine: 'claude', status: 'idle', cwd: '/work/b' })
  })

  it('resolves an agent by its name and still by its title, naming it by the agent', () => {
    const row = (id: string, extra: Partial<PeerSessionSummary>): PeerSessionSummary => ({
      id,
      status: 'idle',
      cwd: `/work/${id}`,
      pendingPermissionCount: 0,
      ...extra,
    })
    const rows = [
      row('e569f467-a88b', { agent: 'WD-Lead' }),
      row('c', { agent: 'Astra', title: 'Fix login bug' }),
      row('d', { agent: 'Same', title: 'Same' }),
    ]
    expect(resolvePeerMentions(rows, 'ask #wd-lead')).toMatchObject([{ typed: 'wd-lead', id: 'e569f467-a88b', name: 'WD-Lead' }])
    expect(resolvePeerMentions(rows, 'ask #Astra and #fix-login-bug').map((m) => [m.id, m.name])).toEqual([['c', 'Astra']])
    expect(resolvePeerMentions(rows, 'ask #Same')).toEqual([expect.not.objectContaining({ ambiguousWith: expect.anything() })])
  })

  it('resolves a session id, whole or as an unambiguous prefix', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a'))
    add(new PeerRunner('b7c1d9e2', { title: 'Astra' }))
    expect(resolvePeerMentions(await service.list('a'), 'see #b7c1d9e2').map((m) => m.id)).toEqual(['b7c1d9e2'])
    expect(resolvePeerMentions(await service.list('a'), 'see #b7c1').map((m) => m.id)).toEqual(['b7c1d9e2'])
    expect(resolvePeerMentions(await service.list('a'), 'see #b7')).toEqual([])
  })

  it('names the other candidates when a title is shared rather than choosing in silence', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a'))
    const older = add(new PeerRunner('b', { title: 'Astra' }))
    const newer = add(new PeerRunner('c', { title: 'Astra' }))
    older.emit({ type: 'status_changed', status: 'idle' })
    newer.emit({ type: 'status_changed', status: 'idle' })
    newer.emit({ type: 'status_changed', status: 'idle' })
    const mentions = resolvePeerMentions(await service.list('a'), 'ask #Astra')
    expect(mentions).toHaveLength(1)
    expect(mentions[0]).toMatchObject({ id: 'c', ambiguousWith: ['b'] })
  })

  it('says nothing about an unknown name, the sender itself, or a peer outside its scope', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { scope: { tenant: 't1' }, title: 'Mine' }))
    add(new PeerRunner('b', { scope: { tenant: 't2' }, title: 'Theirs' }))
    expect(resolvePeerMentions(await service.list('a'), 'ask #Nobody about it')).toEqual([])
    expect(resolvePeerMentions(await service.list('a'), 'ask #Mine about it')).toEqual([])
    expect(resolvePeerMentions(await service.list('a'), 'ask #Theirs about it')).toEqual([])
  })

  it('dedupes a repeated name and caps how many sessions one message can pull in', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a'))
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
      add(new PeerRunner(name.toLowerCase(), { title: name }))
    }
    expect(resolvePeerMentions(await service.list('a'), '#One and #one again')).toHaveLength(1)
    expect(resolvePeerMentions(await service.list('a'), '#One #Two #Three #Four #Five')).toHaveLength(4)
  })

  it('resolves a session on another gateway by title, and an untitled one by its short id', () => {
    const remote = (id: string, title?: string) => ({
      id: `mini:${id}`,
      gateway: 'mini',
      title,
      status: 'idle' as const,
      cwd: '/box',
      pendingPermissionCount: 0,
    })
    const rows = [remote('d652f104-06cd', 'TB-Mini'), remote('77aa0011-2233')]
    expect(resolvePeerMentions(rows, 'ask #TB-Mini then #77aa0011').map((m) => m.id)).toEqual(['mini:d652f104-06cd', 'mini:77aa0011-2233'])
  })

  it('costs nothing when there is no `#` in the text at all', async () => {
    // No registry: reaching for one would throw, which is the proof that the scan short-circuits.
    const service = createPeerService({ refs: {} as LateBoundRefs, projects: new ProjectInfoService() })
    expect(await mentionsFor(service, 'a', 'just an ordinary message')).toEqual([])
  })

  it('never sets mentions on a peer delivery, however many names a model writes', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { title: 'Astra' }))
    const target = add(new PeerRunner('b', { title: 'Luna' }))
    await service.send('a', 'b', 'please look at #Astra and #Luna')
    expect(target.sent[0]?.options?.mentions).toBeUndefined()
    expect(target.sent[0]?.options?.origin).toMatchObject({ kind: 'peer', sessionId: 'a' })
  })
})

function macVouches(ref: { id: string; lead?: string }, gateway: string, accepts: Record<string, string[]>): boolean {
  if (gateway === 'mac' || !ref.id.startsWith(`${gateway}:`)) {
    return false
  }
  if (ref.lead === undefined || !ref.lead.startsWith('mac:')) {
    return true
  }
  return (accepts[ref.lead.slice(4)] ?? []).includes(ref.id)
}

describe('peer service: teams', () => {
  const refs: Record<string, AgentRef> = {
    lead: { id: 'A', name: 'Atlas', leads: true },
    m1: { id: 'P', name: 'Pip', lead: 'A', team: 'Atlas' },
    m2: { id: 'J', name: 'Juno', lead: 'A', team: 'Atlas' },
    solo: { id: 'M', name: 'Marlow' },
    otherLead: { id: 'O', name: 'Orbit', leads: true },
    otherMember: { id: 'F', name: 'Fern', lead: 'O', team: 'Orbit' },
  }

  function teamRig(spanning: string[] = []) {
    const registry = new SessionRegistry()
    const service = createPeerService({
      refs: { registry },
      projects: new ProjectInfoService({ decorate: (info) => (refs[info.id] ? { ...info, agent: refs[info.id] } : info) }),
      teams: {
        relayAgent: (id) => (refs[id] ? { id: refs[id].id, name: refs[id].name, ...(refs[id].lead ? { lead: refs[id].lead } : {}) } : undefined),
        spansGateways: (id) => spanning.includes(id),
        agentName: (id) => Object.values(refs).find((ref) => ref.id === id)?.name,
        vouches: (ref, gateway) => macVouches(ref, gateway, { A: ['pi:T'] }),
      },
    })
    for (const id of [...Object.keys(refs), 'plain']) {
      registry.register(new PeerRunner(id))
    }
    return service
  }

  const reach = async (service: ReturnType<typeof teamRig>, from: string) => (await service.list(from)).map((row) => row.id).sort()

  it('lets a member reach only its lead and teammates', async () => {
    expect(await reach(teamRig(), 'm1')).toEqual(['lead', 'm2'])
  })

  it("lets a lead reach its members and every top-level session, but no other team's members", async () => {
    expect(await reach(teamRig(), 'lead')).toEqual(['m1', 'm2', 'otherLead', 'plain', 'solo'])
  })

  it('keeps members out of reach of solo and agentless sessions', async () => {
    const service = teamRig()
    expect(await reach(service, 'solo')).toEqual(['lead', 'otherLead', 'plain'])
    expect(await reach(service, 'plain')).toEqual(['lead', 'otherLead', 'solo'])
    expect(await service.send('solo', 'm1', 'hi')).toEqual({ delivered: false, reason: 'no such session: m1' })
    expect(await service.peek('otherMember', 'm1')).toBeUndefined()
  })

  it('names the agent, role and team on each row', async () => {
    const rows = await teamRig().list('lead')
    expect(rows.find((row) => row.id === 'm1')).toMatchObject({ agent: 'Pip', role: 'member', team: 'Atlas' })
    expect(rows.find((row) => row.id === 'otherLead')).toMatchObject({ agent: 'Orbit', role: 'lead', team: 'Orbit' })
    expect(rows.find((row) => row.id === 'solo')).toMatchObject({ agent: 'Marlow' })
    expect(rows.find((row) => row.id === 'plain')).not.toHaveProperty('role')
    expect(rows.find((row) => row.id === 'plain')).not.toHaveProperty('agent')
  })

  it('never publishes a member of a team that stays on this gateway', async () => {
    const service = teamRig()
    const published = (await service.relayEntries(undefined, true)).map((entry) => entry.id)
    expect(published).not.toContain('m1')
    expect(published).toContain('lead')
    const origin = { gateway: 'pi', sessionId: 'x', agent: { id: 'mac:lead', name: 'Atlas' }, hops: [] }
    expect(await service.relayPeek(origin, 'm1', 3, undefined, 'mac')).toBeUndefined()
  })

  it('publishes a member whose team spans gateways, and answers only its lead and teammates', async () => {
    const service = teamRig(['m1'])
    const entry = (await service.relayEntries(undefined, true)).find((row) => row.id === 'm1')
    expect(entry?.agent).toEqual({ id: refs.m1!.id, name: 'Pip', lead: refs.m1!.lead })
    const lead = `mac:${refs.m1!.lead}`
    const outsider = { gateway: 'pi', sessionId: 'x', agent: { id: 'pi:Z', name: 'Zed' }, hops: [] }
    const teammate = { gateway: 'pi', sessionId: 'y', agent: { id: 'pi:T', name: 'Tee', lead }, hops: [] }
    const invented = { gateway: 'pi', sessionId: 'w', agent: { id: 'pi:X', name: 'Forged', lead }, hops: [] }
    const misplaced = { gateway: 'evil', sessionId: 'v', agent: { id: 'pi:T', name: 'Tee', lead }, hops: [] }
    expect(await service.relayPeek(outsider, 'm1', 0, undefined, 'mac')).toBeUndefined()
    expect(await service.relayPeek({ ...outsider, agent: undefined }, 'm1', 0, undefined, 'mac')).toBeUndefined()
    expect(await service.relaySend(outsider, 'm1', 'hi', undefined, 'mac')).toEqual({ delivered: false, reason: 'no such session: m1' })
    expect(await service.relayPeek(teammate, 'm1', 0, undefined, 'mac')).toMatchObject({ id: 'm1' })
    expect(await service.relayPeek(invented, 'm1', 0, undefined, 'mac')).toBeUndefined()
    expect(await service.relaySend(invented, 'm1', 'hi', undefined, 'mac')).toEqual({ delivered: false, reason: 'no such session: m1' })
    expect(await service.relayPeek(misplaced, 'm1', 0, undefined, 'mac')).toBeUndefined()
  })

  it('answers a peek with ids qualified by this gateway, and publishes members only once teams are negotiated', async () => {
    const service = teamRig(['m1'])
    const teammate = { gateway: 'pi', sessionId: 'y', agent: { id: 'pi:T', name: 'Tee', lead: 'mac:A' }, hops: [] }
    expect((await service.relayPeek(teammate, 'm1', 0, undefined, 'mac'))?.agent).toEqual({ id: 'mac:P', name: 'Pip', lead: 'mac:A' })
    expect((await service.relayEntries(undefined, false)).map((entry) => entry.id)).not.toContain('m1')
  })

  it('refuses a remote member reaching an outsider here, whatever the relay routed', async () => {
    const service = teamRig()
    const member = { gateway: 'pi', sessionId: 'y', agent: { id: 'pi:Q', name: 'Q', lead: 'pi:K' }, hops: [] }
    expect(await service.relaySend(member, 'solo', 'hi', undefined, 'mac')).toEqual({ delivered: false, reason: 'no such session: solo' })
    expect(await service.relayPeek({ ...member, agent: { id: 'pi:K', name: 'K' } }, 'solo', 0, undefined, 'mac')).toMatchObject({
      id: 'solo',
    })
  })
})

describe('peer service: a job running in bypass', () => {
  it("takes no peer message under disableBypassPermissions 'sessions'", async () => {
    const registry = new SessionRegistry()
    const service = createPeerService({ refs: { registry }, projects: new ProjectInfoService(), disableBypassPermissions: 'sessions' })
    registry.observe((runner) => service.watch(runner))
    registry.register(new PeerRunner('a'))
    const job = new PeerRunner('j')
    const info = job.info.bind(job)
    job.info = () => ({ ...info(), meta: { jobId: 'job-1' }, permissionMode: 'bypassPermissions' })
    registry.register(job)
    expect(await service.send('a', 'j', 'hi')).toMatchObject({ delivered: false, reason: expect.stringContaining('takes no input') })
    expect(job.sent).toEqual([])
  })
})

describe('peer service: reset', () => {
  const refs: Record<string, AgentRef> = {
    lead: { id: 'A', name: 'Atlas', leads: true },
    m1: { id: 'P', name: 'Pip', lead: 'A', team: 'Atlas' },
    m2: { id: 'J', name: 'Juno', lead: 'A', team: 'Atlas' },
    otherLead: { id: 'O', name: 'Orbit', leads: true },
  }

  function resetRig(opts: { blocked?: string[]; shells?: string[]; resets?: boolean; perMinute?: number } = {}) {
    const registry = new SessionRegistry()
    const errors: string[] = []
    const requests: Array<{ sessionId: string; reason: string; guard?: () => Promise<string | undefined>; done?: () => void }> = []
    const service = createPeerService({
      refs: { registry },
      projects: new ProjectInfoService({
        decorate: (info) => ({
          ...info,
          ...(refs[info.id] ? { agent: refs[info.id] } : {}),
          ...(opts.blocked?.includes(info.id) ? { statusLabel: { text: 'need a key', setAt: 1, waitingOn: 'human' as const } } : {}),
        }),
      }),
      liveShell: (id) => opts.shells?.includes(id) === true,
      onError: (error) => void errors.push(String(error)),
      ...(opts.perMinute ? { options: { perMinute: opts.perMinute } } : {}),
      ...(opts.resets === false ? {} : { resets: { requestMember: (sessionId, request) => void requests.push({ sessionId, ...request }) } }),
    })
    const runners = Object.fromEntries([...Object.keys(refs), 'plain'].map((id) => [id, new PeerRunner(id)]))
    for (const runner of Object.values(runners)) {
      registry.register(runner)
    }
    return { service, requests, runners, registry, errors }
  }

  it('schedules a lead\'s reset of its own member, and hands the prompt over as a peer message once the cut ran', async () => {
    const { service, requests, runners } = resetRig()
    expect(await service.reset('lead', 'm1', { prompt: 'start on @NEXT.md' })).toEqual({ scheduled: true, sessionId: 'm1', name: 'Pip' })
    expect(requests).toMatchObject([{ sessionId: 'm1', reason: 'reset by its lead Atlas (lead)' }])
    expect(runners.m1!.sent).toEqual([])
    requests[0]!.done!()
    await eventually(() => expect(runners.m1!.sent).toHaveLength(1))
    expect(runners.m1!.sent[0]).toMatchObject({ text: 'start on @NEXT.md', options: { origin: { kind: 'peer', sessionId: 'lead', name: 'Atlas' } } })
  })

  it('refuses anyone but its own lead, and itself', async () => {
    const { service, requests } = resetRig()
    expect(await service.reset('m2', 'm1')).toEqual({ scheduled: false, reason: 'only its own team lead can reset m1' })
    expect(await service.reset('m1', 'lead')).toEqual({ scheduled: false, reason: 'only its own team lead can reset lead' })
    expect(await service.reset('otherLead', 'm1')).toEqual({ scheduled: false, reason: 'no such session: m1' })
    expect(await service.reset('plain', 'otherLead')).toEqual({ scheduled: false, reason: 'only its own team lead can reset otherLead' })
    expect((await service.reset('lead', 'lead')).scheduled).toBe(false)
    expect(requests).toEqual([])
  })

  it('keeps a member for the human: a pending approval, waiting on the human, a running shell', async () => {
    const { service, requests, runners } = resetRig({ blocked: ['m2'], shells: ['m1'] })
    expect(await service.reset('lead', 'm1')).toMatchObject({ scheduled: false, reason: expect.stringMatching(/running shell/) })
    expect(await service.reset('lead', 'm2')).toMatchObject({ scheduled: false, reason: expect.stringMatching(/waiting on the human/) })
    runners.m2!.pendingApprovals = [{ requestId: 'r', toolName: 'Bash', input: {} } as never]
    expect(await service.reset('lead', 'm2')).toMatchObject({ scheduled: false, reason: expect.stringMatching(/approval/) })
    expect(requests).toEqual([])
  })

  it('hands the prompt over outside the per-minute limit, and reports a hand-over that fails', async () => {
    const { service, requests, runners, errors } = resetRig({ perMinute: 1 })
    await service.send('lead', 'm1', 'one message uses the minute')
    await service.reset('lead', 'm1', { prompt: 'fresh start' })
    requests[0]!.done!()
    await eventually(() => expect(runners.m1!.sent.map((sent) => sent.text)).toEqual(['one message uses the minute', 'fresh start']))
    await service.reset('lead', 'm2', { prompt: 'lost' })
    runners.m2!.status = 'closed'
    requests[1]!.done!()
    await eventually(() => expect(errors).toEqual([expect.stringMatching(/reset of m2 was not delivered: session m2 is closed/)]))
  })

  it('drops the reset when its lead has ended or left the gateway by the time the turn ends', async () => {
    const { service, requests, runners, registry } = resetRig()
    await service.reset('lead', 'm1')
    runners.lead!.status = 'closed'
    await expect(requests[0]!.guard!()).resolves.toBe('its lead has ended')
    runners.lead!.status = 'idle'
    registry.evict('lead')
    await expect(requests[0]!.guard!()).resolves.toBe('its lead has ended')
  })

  it('asks the same rules again when the turn ends', async () => {
    const { service, requests, runners } = resetRig()
    await service.reset('lead', 'm1')
    await expect(requests[0]!.guard!()).resolves.toBeUndefined()
    runners.m1!.pendingApprovals = [{ requestId: 'r', toolName: 'Bash', input: {} } as never]
    await expect(requests[0]!.guard!()).resolves.toMatch(/approval/)
  })

  it('says so when resets are off, and the tool reports the scheduling in prose', async () => {
    expect(await resetRig({ resets: false }).service.reset('lead', 'm1')).toEqual({
      scheduled: false,
      reason: 'agent context resets are turned off on this gateway',
    })
    const { service } = resetRig()
    const out = await runPeerTool(service, 'lead', 'peers_reset', { sessionId: 'm1', prompt: 'go' })
    expect(out).toMatchObject({ isError: false, text: expect.stringMatching(/^Reset scheduled for Pip \(m1\)/) })
    const refused = await runPeerTool(service, 'm2', 'peers_reset', { sessionId: 'm1' })
    expect(refused).toMatchObject({ isError: true, text: 'not reset: only its own team lead can reset m1' })
  })
})
