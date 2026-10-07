import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectRelay,
  type RelayConnection,
  type RelayFeature,
  type RelayHost,
  type RelayOp,
  type RelaySessionEntry,
  type RelayTeamOrigin,
  type TeamFrameKind,
  type TeamRoster,
  type TeamStatusBody,
} from '@workerdeck/relay-client'
import { enrollGateway, enrollGatewayHash, readEnrollments, setGatewayOwner, setGatewayOwners, writeKeyFile } from '../src/enrollment.ts'
import { parseRules } from '../src/rules.ts'
import { startRelay, type Relay } from '../src/relay.ts'
import { accessOps, projectCard, projectForOtherOwner, sanitizeAgent, teamAllows, type TeamNode } from '../src/teams.ts'

type TeamCall = { kind: TeamFrameKind; origin: RelayTeamOrigin; to: string; op?: string }

type FakeGateway = {
  entries: RelaySessionEntry[]
  team: TeamCall[]
  status: Array<{ origin: { gateway: string; owner: string } } & TeamStatusBody>
  rosters: TeamRoster[]
  host: RelayHost
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
    await cleanup()
  }
})

function entry(id: string, extra: Partial<RelaySessionEntry> = {}): RelaySessionEntry {
  return { id, status: 'idle', cwd: `/work/${id}`, createdAt: 1, pendingPermissionCount: 0, live: true, ...extra }
}

function fakeGateway(entries: RelaySessionEntry[]): FakeGateway {
  const gateway: FakeGateway = {
    entries,
    team: [],
    status: [],
    rosters: [],
    host: {
      snapshot: async () => gateway.entries,
      peek: async (_origin, to) => {
        const found = gateway.entries.find((row) => row.id === to)
        return found ? { ...found, pendingApprovals: [], recent: [] } : undefined
      },
      send: async (_origin, to) => ({ delivered: true, sessionId: to, queued: false }),
      team: async (kind, origin, to, op) => {
        gateway.team.push({ kind, origin, to, ...(op === undefined ? {} : { op }) })
        return { ok: true, leadName: 'Lead' }
      },
      teamStatus: async (origin, body) => {
        gateway.status.push({ origin, ...body })
        return {
          edges: body.edges.map(() => ({ known: true, name: 'Member' })),
          rosters: gateway.rosters,
          seen: [
            { lead: 'mac:L', epoch: 'e1', rev: 3 },
            { lead: 'pi:M', epoch: 'e1', rev: 3 },
          ],
        }
      },
    },
  }
  return gateway
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function setup(rules: unknown, extra: { teamPerMinute?: number; invitesPerDay?: number } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-teams-'))
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
  await writeFile(join(stateDir, 'rules.json'), JSON.stringify(rules))
  const relay = await startRelay({ stateDir, port: 0, log: () => {}, watchIntervalMs: 50, heartbeatMs: 60_000, ...extra })
  cleanups.push(() => relay.close())
  return { stateDir, relay }
}

type Attach = { owner?: string; owners?: string[]; allow?: RelayOp[]; features?: RelayFeature[] }

async function attach(relay: Relay, stateDir: string, name: string, gateway: FakeGateway, options: Attach = {}): Promise<RelayConnection> {
  const key = await enrollGateway(stateDir, name, { owner: options.owner, owners: options.owners })
  await relay.reload()
  const connection = connectRelay(
    {
      url: relay.url,
      gateway: name,
      key,
      allow: options.allow ?? ['send', 'peek', 'team'],
      features: options.features ?? ['teams'],
      tickMs: 30,
      digestMs: 60_000,
      backoffMinMs: 20,
      backoffMaxMs: 100,
    },
    gateway.host,
  )
  cleanups.push(() => connection.close())
  await until(() => connection.state() === 'online', `${name} online`)
  await until(() => relay.status().gateways.find((row) => row.name === name)?.sessions === gateway.entries.length, `${name} snapshot`)
  return connection
}

function ids(rows: Array<{ gateway: string; id: string }>): string[] {
  return rows.map((row) => `${row.gateway}:${row.id}`).sort()
}

const SAME_AND_CROSS = {
  rules: [
    { from: '*', to: '*', allow: ['send', 'peek', 'team'] },
    { from: '*', to: '*', crossOperator: true, allow: ['send', 'peek', 'team'] },
  ],
}

describe('team visibility (pure)', () => {
  const node = (gateway: string, owner: string, agent?: TeamNode['agent']): TeamNode => ({ gateway, owner, agent })

  it('validates a remote membership only against the lead accepts', () => {
    const lead = node('mac', 'tobias', { id: 'mac:L', name: 'Lead', accepts: ['pi:M'] })
    const member = node('pi', 'tobias', { id: 'pi:M', name: 'Member', lead: 'mac:L' })
    const stranger = node('pi', 'tobias', { id: 'pi:S', name: 'Stranger', lead: 'mac:L' })
    const top = node('mac', 'tobias', { id: 'mac:T', name: 'Top' })
    const lookup = (id: string) => (id === 'mac:L' ? lead : undefined)
    expect(teamAllows(lead, member, lookup)).toBe('all')
    expect(teamAllows(member, lead, lookup)).toBe('all')
    expect(teamAllows(stranger, lead, lookup)).toBe('none')
    expect(teamAllows(top, member, lookup)).toBe('none')
    expect(teamAllows(member, top, lookup)).toBe('none')
    expect(teamAllows(top, lead, lookup)).toBe('all')
    expect(teamAllows(member, lead, () => undefined)).toBe('none')
  })

  it('across owners sees team rows and pairs of shared top-level agents only', () => {
    const lead = node('mac', 'tobias', { id: 'mac:L', name: 'Lead', accepts: ['dan:M'] })
    const member = node('dan', 'dan', { id: 'dan:M', name: 'Member', lead: 'mac:L' })
    const plain = node('dan', 'dan', { id: 'dan:P', name: 'Plain' })
    const lookup = (id: string) => (id === 'mac:L' ? lead : undefined)
    expect(teamAllows(lead, member, lookup)).toBe('all')
    expect(teamAllows(lead, plain, lookup)).toBe('none')
    expect(teamAllows(node('mac', 'tobias'), node('dan', 'dan'), lookup)).toBe('none')
    const shared = node('dan', 'dan', { id: 'dan:S', name: 'Shared', shared: true })
    const sharedLead = node('mac', 'tobias', { ...lead.agent!, shared: true })
    expect(teamAllows(lead, shared, lookup)).toBe('none')
    expect(teamAllows(sharedLead, shared, lookup)).toBe('message')
    expect(teamAllows(shared, sharedLead, lookup)).toBe('message')
    expect(teamAllows(sharedLead, { ...member, agent: { ...member.agent!, shared: true } }, lookup)).toBe('all')
    expect(teamAllows(node('mac', 'tobias', { id: 'mac:X', name: 'X', lead: 'mac:L', shared: true }), shared, lookup)).toBe('none')
  })

  it('keeps send from a session of another owner that runs without prompts', () => {
    const lead = node('mac', 'tobias', { id: 'mac:L', name: 'Lead', accepts: ['dan:M'], shared: true })
    const member = { ...node('dan', 'dan', { id: 'dan:M', name: 'Member', lead: 'mac:L' }), permissionMode: 'bypassPermissions' }
    const shared = { ...node('dan', 'dan', { id: 'dan:S', name: 'Shared', shared: true }), permissionMode: 'dontAsk' }
    const ops = ['send', 'peek'] as const
    expect(
      accessOps(
        teamAllows(lead, member, () => lead),
        ops,
        lead,
        member,
      ),
    ).toEqual(['peek'])
    expect(
      accessOps(
        teamAllows(lead, shared, () => lead),
        ops,
        lead,
        shared,
      ),
    ).toEqual([])
    expect(
      accessOps(
        teamAllows(shared, lead, () => lead),
        ops,
        shared,
        lead,
      ),
    ).toEqual(['send'])
    expect(accessOps('all', ops, node('dan', 'dan'), member)).toEqual(['send', 'peek'])
  })

  it('drops an agent id that names another gateway and qualifies the rest', () => {
    expect(sanitizeAgent('pi', { id: 'mac:L', name: 'Forged' })).toBeUndefined()
    expect(sanitizeAgent('pi', { id: 'M', name: 'Member', lead: 'mac:L', accepts: ['X', 'dan:Y'], shared: true })).toEqual({
      id: 'pi:M',
      name: 'Member',
      lead: 'mac:L',
      accepts: ['pi:X', 'dan:Y'],
    })
  })

  it('projects away paths and profile for another owner', () => {
    const shown = projectForOtherOwner(entry('s', { project: { name: 'web', root: '/srv/web' }, profile: 'p', permissionMode: 'plan' }))
    expect(shown).toEqual(expect.objectContaining({ cwd: '', project: { name: 'web', root: '' } }))
    expect(shown).not.toHaveProperty('profile')
    expect(shown).not.toHaveProperty('permissionMode')
  })
})

describe('rules and enrollment', () => {
  it('a rule without allow grants send and peek only, and crossOperator must be a boolean', () => {
    expect(parseRules({ rules: [{ from: '*', to: '*' }] })[0]!.allow).toEqual(['send', 'peek'])
    expect(parseRules({ rules: [{ from: '*', to: '*', allow: ['team'], crossOperator: true }] })[0]).toEqual({
      from: '*',
      to: '*',
      allow: ['team'],
      crossOperator: true,
    })
    expect(() => parseRules({ rules: [{ from: '*', to: '*', crossOperator: 'yes' }] })).toThrow(/crossOperator/)
    expect(() => parseRules({ rules: [{ from: '*', to: '*', allow: ['shell'] }] })).toThrow(/allow/)
  })

  it('keygen writes a 0600 key and enrolls by hash; owner is kept on rotate and can be changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wd-keygen-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const keyFile = join(dir, 'relay.key')
    const hash = await writeKeyFile(keyFile)
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
    await expect(writeKeyFile(keyFile)).rejects.toThrow(/EEXIST/)
    await enrollGatewayHash(dir, 'dan-laptop', hash, { owner: 'dan' })
    await expect(enrollGatewayHash(dir, 'x', 'nothex')).rejects.toThrow(/hash/)
    await expect(enrollGateway(dir, 'y', { owner: 'Not Valid' })).rejects.toThrow(/owner/)
    await enrollGateway(dir, 'dan-laptop', { rotate: true })
    expect((await readEnrollments(dir)).gateways['dan-laptop']?.owner).toBe('dan')
    await setGatewayOwner(dir, 'dan-laptop', 'ruli')
    expect((await readEnrollments(dir)).gateways['dan-laptop']?.owner).toBe('ruli')

    const relay = await startRelay({ stateDir: dir, port: 0, log: () => {}, heartbeatMs: 60_000 })
    cleanups.push(() => relay.close())
    const key = (await readFile(keyFile, 'utf8')).trim()
    await enrollGatewayHash(dir, 'ruli-pc', hash, { owner: 'ruli' })
    await relay.reload()
    const connection = connectRelay({ url: relay.url, gateway: 'ruli-pc', key, backoffMinMs: 20 }, fakeGateway([]).host)
    cleanups.push(() => connection.close())
    await until(() => connection.state() === 'online', 'hash-enrolled gateway online')
    expect(connection.owner()).toBe('ruli')
  })
})

describe('relay across owners', () => {
  it('a wildcard rule never crosses owners; enrollments without owner behave as one owner', async () => {
    const { stateDir, relay } = await setup({ rules: [{ from: '*', to: '*' }] })
    const mac = fakeGateway([entry('m1')])
    const pi = fakeGateway([entry('p1')])
    const dan = fakeGateway([entry('d1')])
    const connMac = await attach(relay, stateDir, 'mac', mac)
    await attach(relay, stateDir, 'pi', pi)
    const connDan = await attach(relay, stateDir, 'dan-laptop', dan, { owner: 'dan' })
    expect(ids(await connMac.list('m1'))).toEqual(['pi:p1'])
    expect(await connDan.list('d1')).toEqual([])
    expect(relay.status().gateways.map((row) => [row.name, row.owner])).toEqual([
      ['dan-laptop', 'dan'],
      ['mac', 'operator'],
      ['pi', 'operator'],
    ])
  })

  it('shows another owner team rows only, projected, and keeps member reach to its team', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS)
    const mac = fakeGateway([
      entry('lead', { agent: { id: 'L', name: 'AC-Lead', accepts: ['dan-laptop:M', 'pi:N'] }, project: { name: 'ac', root: '/ac' } }),
      entry('top', { agent: { id: 'T', name: 'Top' } }),
      entry('plain'),
    ])
    const pi = fakeGateway([entry('n', { agent: { id: 'N', name: 'Mate', lead: 'mac:L' } }), entry('pplain')])
    const dan = fakeGateway([entry('m', { agent: { id: 'M', name: 'Dan-Scout', lead: 'mac:L' } }), entry('dplain')])
    const connMac = await attach(relay, stateDir, 'mac', mac, { owner: 'tobias' })
    const connPi = await attach(relay, stateDir, 'pi', pi, { owner: 'tobias' })
    const connDan = await attach(relay, stateDir, 'dan-laptop', dan, { owner: 'dan' })

    const fromDan = await connDan.list('m')
    expect(ids(fromDan)).toEqual(['mac:lead', 'pi:n'])
    expect(fromDan.find((row) => row.id === 'lead')).toEqual(
      expect.objectContaining({ cwd: '', project: { name: 'ac', root: '' }, owner: 'tobias', allow: ['send', 'peek'] }),
    )
    expect(await connDan.list('dplain')).toEqual([])
    expect(ids(await connMac.list('lead'))).toEqual(['dan-laptop:m', 'pi:n', 'pi:pplain'])
    expect(ids(await connMac.list('top'))).toEqual(['pi:pplain'])
    expect(ids(await connPi.list('n'))).toEqual(['dan-laptop:m', 'mac:lead'])
    expect(ids(await connPi.list('pplain'))).toEqual(['mac:lead', 'mac:plain', 'mac:top'])

    expect(await connMac.send('top', { gateway: 'dan-laptop', id: 'm' }, 'hi', [])).toEqual({
      delivered: false,
      reason: 'no such session: dan-laptop:m',
    })
    expect((await connMac.send('lead', { gateway: 'dan-laptop', id: 'm' }, 'hi', [])).delivered).toBe(true)
  })

  it('a member whose lead does not accept it sees nothing and is seen by nobody', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS)
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead' } }), entry('top')])
    const pi = fakeGateway([entry('m', { agent: { id: 'M', name: 'Claimer', lead: 'mac:L' } })])
    const connMac = await attach(relay, stateDir, 'mac', mac)
    const connPi = await attach(relay, stateDir, 'pi', pi)
    expect(await connPi.list('m')).toEqual([])
    expect(await connMac.list('lead')).toEqual([])
    expect(await connMac.list('top')).toEqual([])
  })

  it('shows shared top-level agents of other owners as cards that take messages and no peek', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS)
    const sent: unknown[] = []
    const card = { project: { name: 'box', root: '/box' }, checklist: { done: 1, total: 3 }, numTurns: 9, pendingPermissionCount: 2 }
    const mini = fakeGateway([
      entry('box', { ...card, agent: { id: 'B', name: 'Box-Lead', shared: true, accepts: ['mini:X'] } }),
      entry('quiet', { agent: { id: 'Q', name: 'Quiet' } }),
      entry('wild', { agent: { id: 'W', name: 'Wild', shared: true }, permissionMode: 'bypassPermissions' }),
      entry('member', { agent: { id: 'X', name: 'Mate', lead: 'mini:B', shared: true } }),
    ])
    const mac = fakeGateway([
      entry('stack', { agent: { id: 'S', name: 'Stack-Lead', shared: true } }),
      entry('solo', { agent: { id: 'P', name: 'Solo' } }),
    ])
    mini.host.send = async (origin, to) => {
      sent.push(origin)
      return { delivered: true, sessionId: to, queued: false }
    }
    await attach(relay, stateDir, 'mini', mini, { owner: 'silkweave' })
    const connMac = await attach(relay, stateDir, 'mac', mac, { owner: 'tobias' })

    const rows = await connMac.list('stack')
    expect(ids(rows)).toEqual(['mini:box'])
    expect(rows[0]).toEqual(
      expect.objectContaining({
        agent: { id: 'mini:B', name: 'Box-Lead', shared: true },
        allow: ['send'],
        pendingPermissionCount: 0,
        cwd: '',
      }),
    )
    expect(rows[0]).not.toHaveProperty('checklist')
    expect(rows[0]).not.toHaveProperty('numTurns')
    expect(await connMac.list('solo')).toEqual([])
    expect(await connMac.peek('stack', { gateway: 'mini', id: 'box' })).toBeUndefined()
    expect((await connMac.send('stack', { gateway: 'mini', id: 'box' }, 'pull and migrate', [])).delivered).toBe(true)
    expect(sent).toMatchObject([{ owner: 'tobias', agent: { id: 'mac:S', shared: true } }])
    expect((await connMac.send('solo', { gateway: 'mini', id: 'box' }, 'hi', [])).delivered).toBe(false)
    expect((await connMac.send('stack', { gateway: 'mini', id: 'wild' }, 'hi', [])).delivered).toBe(false)
  })

  it('stamps owner and agent name on a peer origin', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS)
    const sent: unknown[] = []
    const mac = fakeGateway([entry('lead', { title: 'session title', agent: { id: 'L', name: 'AC-Lead', accepts: ['dan-laptop:M'] } })])
    const dan = fakeGateway([entry('m', { agent: { id: 'M', name: 'Scout', lead: 'mac:L' } })])
    dan.host.send = async (origin, to) => {
      sent.push(origin)
      return { delivered: true, sessionId: to, queued: false }
    }
    const connMac = await attach(relay, stateDir, 'mac', mac, { owner: 'tobias' })
    await attach(relay, stateDir, 'dan-laptop', dan, { owner: 'dan' })
    await connMac.send('lead', { gateway: 'dan-laptop', id: 'm' }, 'hello', [])
    expect(sent).toEqual([
      { gateway: 'mac', owner: 'tobias', sessionId: 'lead', name: 'AC-Lead', agent: { id: 'mac:L', name: 'AC-Lead' }, hops: [] },
    ])
  })
})

describe('team frames', () => {
  it('routes team.join with a relay-stamped origin, only when the rule and ceiling grant team', async () => {
    const { stateDir, relay } = await setup({
      rules: [
        { from: 'pi', to: 'mac', allow: ['team'] },
        { from: 'mac', to: 'pi' },
      ],
    })
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'AC-Lead' } })])
    const pi = fakeGateway([entry('m', { agent: { id: 'M', name: 'AC-MagWin' } })])
    const connMac = await attach(relay, stateDir, 'mac', mac, { owner: 'tobias' })
    const connPi = await attach(relay, stateDir, 'pi', pi, { owner: 'tobias' })

    expect(await connPi.team('team.join', 'M', 'mac:L')).toEqual({ ok: true, leadName: 'Lead', owner: 'tobias' })
    expect(mac.team).toEqual([{ kind: 'team.join', origin: { gateway: 'pi', owner: 'tobias', agent: 'pi:M', name: 'AC-MagWin' }, to: 'L' }])
    expect(await connMac.team('team.release', 'L', 'pi:M')).toEqual({ ok: false, reason: 'no such agent' })
    expect(await connPi.team('team.join', 'mac:X', 'mac:L')).toEqual({ ok: false, reason: 'no such agent' })
    expect(await connPi.team('team.join', 'M', 'mac:nobody')).toEqual({ ok: false, reason: 'no such agent' })
    expect(pi.team).toEqual([])
  })

  it('refuses team frames to a gateway whose ceiling lacks team or that did not announce the feature', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS)
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead' } })])
    const pi = fakeGateway([entry('m', { agent: { id: 'M', name: 'M' } })])
    const old = fakeGateway([entry('o', { agent: { id: 'O', name: 'O' } })])
    await attach(relay, stateDir, 'mac', mac, { allow: ['send', 'peek'] })
    const connPi = await attach(relay, stateDir, 'pi', pi)
    const connOld = await attach(relay, stateDir, 'old', old, { features: [] })
    expect(await connPi.team('team.join', 'M', 'mac:L')).toEqual({ ok: false, reason: 'no such agent' })
    expect(await connPi.team('team.join', 'M', 'old:O')).toEqual({ ok: false, reason: 'no such agent' })
    expect(connOld.features()).toEqual([])
    await expect(connOld.team('team.join', 'O', 'pi:M')).rejects.toThrow(/does not route teams/)
    expect(mac.team).toEqual([])
    expect(old.team).toEqual([])
  })

  it('answers invite and request ok whatever happens, and limits them per owner pair a day', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS, { invitesPerDay: 2 })
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead' } })])
    const dan = fakeGateway([entry('m', { agent: { id: 'M', name: 'Scout' } })])
    const connMac = await attach(relay, stateDir, 'mac', mac, { owner: 'tobias' })
    await attach(relay, stateDir, 'dan-laptop', dan, { owner: 'dan' })
    expect(await connMac.team('team.invite', 'L', 'dan-laptop:nobody')).toEqual({ ok: true })
    expect(await connMac.team('team.invite', 'L', 'dan-laptop:M')).toEqual({ ok: true })
    expect(await connMac.team('team.invite', 'L', 'dan-laptop:M')).toEqual({ ok: true })
    expect(await connMac.team('team.invite', 'L', 'dan-laptop:M')).toEqual({ ok: true })
    await until(() => dan.team.length === 2, 'two invites delivered')
    expect(dan.team[0]).toEqual({ kind: 'team.invite', origin: { gateway: 'mac', owner: 'tobias', agent: 'mac:L', name: 'Lead' }, to: 'M' })
  })

  it('limits team requests per gateway pair a minute', async () => {
    const { stateDir, relay } = await setup(SAME_AND_CROSS, { teamPerMinute: 2 })
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead' } })])
    const pi = fakeGateway([entry('m', { agent: { id: 'M', name: 'M' } })])
    await attach(relay, stateDir, 'mac', mac)
    const connPi = await attach(relay, stateDir, 'pi', pi)
    expect((await connPi.team('team.join', 'M', 'mac:L')).ok).toBe(true)
    expect((await connPi.team('team.leave', 'M', 'mac:L')).ok).toBe(true)
    const third = await connPi.team('team.join', 'M', 'mac:L')
    expect(third.ok === false && third.reason).toMatch(/rate limit/)
  })

  it('reconciles with team.status: only granted edges are forwarded, answers come back per edge', async () => {
    const { stateDir, relay } = await setup({
      rules: [{ from: '*', to: '*', allow: ['send', 'peek', 'team'], scope: { projects: ['/ac'] } }],
    })
    const mac = fakeGateway([entry('lead', { cwd: '/ac', agent: { id: 'L', name: 'Lead', accepts: ['pi:M', 'pi:Z'] } })])
    const pi = fakeGateway([entry('m', { cwd: '/ac/x', agent: { id: 'M', name: 'M', lead: 'mac:L' } }), entry('z', { cwd: '/elsewhere' })])
    const connMac = await attach(relay, stateDir, 'mac', mac)
    await attach(relay, stateDir, 'pi', pi)
    const answer = await connMac.teamStatus('pi', {
      edges: [
        { from: 'L', to: 'pi:M', op: 'o1' },
        { from: 'L', to: 'pi:Z' },
        { from: 'L', to: 'mac:L' },
        { from: 'pi:forged', to: 'pi:M' },
      ],
    })
    expect(answer.edges).toEqual([{ from: 'L', to: 'pi:M', op: 'o1', known: true, name: 'Member' }])
    expect(pi.status).toEqual([
      {
        origin: { gateway: 'mac', owner: 'operator' },
        edges: [{ from: 'mac:L', to: 'M', op: 'o1', owner: 'operator' }],
        rosters: [],
        seen: [],
      },
    ])
    await expect(connMac.teamStatus('gone', { edges: [{ from: 'L', to: 'gone:M' }] })).rejects.toThrow(/unreachable/)
  })

  it('carries rosters only for the issuing gateway own leads, qualified, and seen only about the receiver', async () => {
    const { stateDir, relay } = await setup({ rules: [{ from: '*', to: '*', allow: ['send', 'peek', 'team'] }] })
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead', accepts: ['pi:M'] } })])
    const pi = fakeGateway([entry('m', { agent: { id: 'M', name: 'M', lead: 'mac:L' } })])
    pi.rosters = [
      { lead: 'M', epoch: 'e', rev: 1, members: [{ id: 'X' }] },
      { lead: 'mac:L', epoch: 'e', rev: 9, members: [{ id: 'pi:evil' }] },
    ]
    const connMac = await attach(relay, stateDir, 'mac', mac)
    await attach(relay, stateDir, 'pi', pi)
    const answer = await connMac.teamStatus('pi', {
      edges: [{ from: 'L', to: 'pi:M', op: 'o1' }],
      rosters: [
        { lead: 'L', epoch: 'e1', rev: 2, members: [{ id: 'T', name: 'Teammate' }, { id: 'pi:M' }] },
        { lead: 'pi:M', epoch: 'e1', rev: 2, members: [] },
      ],
      seen: [
        { lead: 'pi:M', epoch: 'e1', rev: 1 },
        { lead: 'mac:L', epoch: 'e1', rev: 1 },
      ],
    })
    expect(pi.status[0]!.rosters).toEqual([
      { lead: 'mac:L', epoch: 'e1', rev: 2, members: [{ id: 'mac:T', name: 'Teammate' }, { id: 'pi:M' }] },
    ])
    expect(pi.status[0]!.seen).toEqual([{ lead: 'pi:M', epoch: 'e1', rev: 1 }])
    expect(answer.rosters).toEqual([{ lead: 'pi:M', epoch: 'e', rev: 1, members: [{ id: 'pi:X' }] }])
    expect(answer.seen).toEqual([{ lead: 'mac:L', epoch: 'e1', rev: 3 }])
  })

  it('passes a join operation id through to the target gateway', async () => {
    const { stateDir, relay } = await setup({ rules: [{ from: '*', to: '*', allow: ['send', 'peek', 'team'] }] })
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead' } })])
    const pi = fakeGateway([entry('m', { agent: { id: 'M', name: 'M' } })])
    await attach(relay, stateDir, 'mac', mac)
    const connPi = await attach(relay, stateDir, 'pi', pi)
    await connPi.team('team.join', 'M', 'mac:L', 'op-1')
    await connPi.team('team.leave', 'M', 'mac:L', 'x'.repeat(65))
    expect(mac.team.map((call) => call.op)).toEqual(['op-1', undefined])
  })
})

describe('several owners on one gateway', () => {
  const SAME_ONLY = { rules: [{ from: '*', to: '*', allow: ['send', 'peek', 'team'] }] }

  function mini(): FakeGateway {
    return fakeGateway([
      entry('t', { owner: 'tobias', title: 'Toby' }),
      entry('r', { owner: 'ruli', title: 'Ruli' }),
      entry('e', { owner: 'eve', title: 'Eve' }),
      entry('n', { title: 'Nobody' }),
      entry('tm', { owner: 'tobias', agent: { id: 'TM', name: 'Toby-Agent' } }),
      entry('rm', { owner: 'ruli', agent: { id: 'RM', name: 'Ruli-Agent' } }),
    ])
  }

  async function three(rules: unknown = SAME_ONLY) {
    const { stateDir, relay } = await setup(rules)
    const shared = mini()
    const mac = fakeGateway([entry('lead', { agent: { id: 'L', name: 'Lead' } }), entry('plain')])
    const ruli = fakeGateway([entry('rp')])
    const connMini = await attach(relay, stateDir, 'mini', shared, {
      owners: ['silkweave', 'tobias', 'ruli'],
      features: ['teams', 'owners'],
    })
    const connMac = await attach(relay, stateDir, 'mac', mac, { owner: 'tobias' })
    const connRuli = await attach(relay, stateDir, 'ruli-mbp', ruli, { owner: 'ruli' })
    return { stateDir, relay, shared, mac, ruli, connMini, connMac, connRuli }
  }

  it('welcomes a multi-owner gateway with its owner set', async () => {
    const { connMini, connMac, relay } = await three()
    expect(connMini.owners()).toEqual(['silkweave', 'tobias', 'ruli'])
    expect(connMac.owners()).toEqual(['tobias'])
    expect(relay.status().gateways.find((row) => row.name === 'mini')?.owners).toEqual(['silkweave', 'tobias', 'ruli'])
  })

  it('lists each entry under its own owner, and drops entries naming no enrolled owner', async () => {
    const { connMac, connRuli } = await three()
    const fromMac = await connMac.list('plain')
    expect(ids(fromMac.filter((row) => row.gateway === 'mini'))).toEqual(['mini:t', 'mini:tm'])
    expect(fromMac.find((row) => row.id === 't')).toMatchObject({ owner: 'tobias', cwd: '/work/t' })
    expect(ids((await connRuli.list('rp')).filter((row) => row.gateway === 'mini'))).toEqual(['mini:r', 'mini:rm'])
  })

  it('projects a row for another owner even when it lives on the same gateway as one of yours', async () => {
    const { mac, shared, connMac, relay } = await three(SAME_AND_CROSS)
    mac.entries[0] = entry('lead', { agent: { id: 'L', name: 'Lead', accepts: ['mini:RM'] } })
    shared.entries[5] = entry('rm', { owner: 'ruli', agent: { id: 'RM', name: 'Ruli-Agent', lead: 'mac:L' } })
    await until(async () => (await connMac.list('lead')).some((row) => row.id === 'rm'), 'the member row')
    const rows = await connMac.list('lead')
    expect(rows.find((row) => row.id === 'rm')).toMatchObject({ owner: 'ruli', cwd: '' })
    expect(rows.find((row) => row.id === 'tm')).toMatchObject({ owner: 'tobias', cwd: '/work/tm' })
    expect(relay.status().gateways.find((row) => row.name === 'mini')?.owner).toBe('silkweave')
  })

  it('stamps origins with the sending session owner and applies the rules per pair of sessions', async () => {
    const { connMini, mac } = await three()
    const origins: unknown[] = []
    mac.host.send = async (origin, to) => {
      origins.push(origin.owner)
      return { delivered: true, sessionId: to, queued: false }
    }
    expect((await connMini.send('t', { gateway: 'mac', id: 'plain' }, 'hi', [])).delivered).toBe(true)
    expect((await connMini.send('r', { gateway: 'mac', id: 'plain' }, 'hi', [])).delivered).toBe(false)
    expect((await connMini.send('e', { gateway: 'mac', id: 'plain' }, 'hi', [])).delivered).toBe(false)
    expect(origins).toEqual(['tobias'])
  })

  it('checks the owner a team frame claims against the enrolled set and against the agent row', async () => {
    const { connMini, mac } = await three(SAME_AND_CROSS)
    expect(await connMini.team('team.join', 'D', 'mac:L', 'o1', 'ruli')).toEqual({ ok: true, leadName: 'Lead', owner: 'tobias' })
    expect(await connMini.team('team.join', 'D', 'mac:L', 'o2', 'eve')).toEqual({ ok: false, reason: 'no such agent' })
    expect(await connMini.team('team.join', 'D', 'mac:L', 'o3')).toEqual({ ok: false, reason: 'no such agent' })
    expect(await connMini.team('team.join', 'TM', 'mac:L', 'o4', 'ruli')).toEqual({ ok: false, reason: 'no such agent' })
    expect((await connMini.team('team.join', 'TM', 'mac:L', 'o5')).ok).toBe(true)
    expect(mac.team.map((call) => [call.origin.agent, call.origin.owner, call.op])).toEqual([
      ['mini:D', 'ruli', 'o1'],
      ['mini:TM', 'tobias', 'o5'],
    ])
  })

  it('forwards a mixed-owner status batch edge by edge, each under its own owner', async () => {
    const { connMini, mac } = await three()
    const answer = await connMini.teamStatus('mac', {
      edges: [
        { from: 'TM', to: 'mac:L', op: 'a' },
        { from: 'RM', to: 'mac:L', op: 'b' },
        { from: 'D', to: 'mac:L', op: 'c', owner: 'tobias' },
      ],
    })
    expect(answer.edges.map((edge) => edge.op)).toEqual(['a', 'c'])
    expect(mac.status[0]?.edges).toEqual([
      { from: 'mini:TM', to: 'L', op: 'a', owner: 'tobias' },
      { from: 'mini:D', to: 'L', op: 'c', owner: 'tobias' },
    ])
  })

  it('drops the rows of an owner removed from the enrollment at reload', async () => {
    const { stateDir, relay, connRuli } = await three()
    expect((await connRuli.list('rp')).some((row) => row.gateway === 'mini')).toBe(true)
    await setGatewayOwners(stateDir, 'mini', ['silkweave', 'tobias'])
    await relay.reload()
    expect((await connRuli.list('rp')).some((row) => row.gateway === 'mini')).toBe(false)
  })

  it('refuses the hello of a gateway enrolled with several owners that cannot name them', async () => {
    const { stateDir, relay } = await setup(SAME_ONLY)
    const key = await enrollGateway(stateDir, 'old-mini', { owners: ['silkweave', 'tobias'] })
    await relay.reload()
    const lines: string[] = []
    const connection = connectRelay(
      {
        url: relay.url,
        gateway: 'old-mini',
        key,
        features: ['teams'],
        backoffMinMs: 20,
        backoffMaxMs: 60_000,
        log: (line) => lines.push(line),
      },
      fakeGateway([]).host,
    )
    cleanups.push(() => connection.close())
    await until(() => lines.some((line) => line.includes('several owners')), 'the refusal logged')
    expect(connection.state()).not.toBe('online')
    expect(relay.status().gateways.find((row) => row.name === 'old-mini')?.online).toBe(false)
  })

  it('drops an old gateway whose enrollment gains a second owner', async () => {
    const { stateDir, relay } = await setup(SAME_ONLY)
    await attach(relay, stateDir, 'pi', fakeGateway([entry('p')]), { owner: 'tobias' })
    await setGatewayOwners(stateDir, 'pi', ['tobias', 'ruli'])
    await relay.reload()
    expect(relay.status().gateways.find((row) => row.name === 'pi')?.online).toBe(false)
  })
})

describe('enrollment with several owners', () => {
  it('hides the key hash from older relays and reads it back', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-owners-'))
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
    await enrollGateway(stateDir, 'mini', { owners: ['silkweave', 'tobias'] })
    await enrollGateway(stateDir, 'mac', { owners: ['tobias'] })
    const raw = JSON.parse(await readFile(join(stateDir, 'gateways.json'), 'utf8'))
    expect(raw.gateways.mini.hash).toBeUndefined()
    expect(raw.gateways.mini.ownersHash).toMatch(/^[0-9a-f]{64}$/)
    expect(raw.gateways.mac).toMatchObject({ owner: 'tobias' })
    const file = await readEnrollments(stateDir)
    expect(file.gateways.mini?.owners).toEqual(['silkweave', 'tobias'])
    expect(file.gateways.mac?.owner).toBe('tobias')
    await expect(enrollGateway(stateDir, 'x', { owner: 'a', owners: ['b'] })).rejects.toThrow(/not both/)
    await expect(enrollGateway(stateDir, 'y', { owners: ['Bad Name'] })).rejects.toThrow(/owner/)
  })

  it('drops a multi-owner record whose owner list is unreadable instead of narrowing it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-owners-'))
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
    const hash = 'a'.repeat(64)
    await writeFile(
      join(stateDir, 'gateways.json'),
      JSON.stringify({
        version: 1,
        gateways: { mini: { ownersHash: hash, owners: ['tobias', 'NOT OK'] }, ok: { ownersHash: hash, owners: ['a', 'b'] } },
      }),
    )
    const file = await readEnrollments(stateDir)
    expect(Object.keys(file.gateways)).toEqual(['ok'])
  })
})
