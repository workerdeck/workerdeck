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
  type TeamEdge,
  type TeamFrameKind,
} from '@workerdeck/relay-client'
import { enrollGateway, enrollGatewayHash, readEnrollments, setGatewayOwner, writeKeyFile } from '../src/enrollment.ts'
import { parseRules } from '../src/rules.ts'
import { startRelay, type Relay } from '../src/relay.ts'
import { projectForOtherOwner, sanitizeAgent, teamAllows, type TeamNode } from '../src/teams.ts'

type TeamCall = { kind: TeamFrameKind; origin: RelayTeamOrigin; to: string }

type FakeGateway = {
  entries: RelaySessionEntry[]
  team: TeamCall[]
  status: Array<{ origin: { gateway: string; owner: string }; edges: TeamEdge[] }>
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
    host: {
      snapshot: async () => gateway.entries,
      peek: async (_origin, to) => {
        const found = gateway.entries.find((row) => row.id === to)
        return found ? { ...found, pendingApprovals: [], recent: [] } : undefined
      },
      send: async (_origin, to) => ({ delivered: true, sessionId: to, queued: false }),
      team: async (kind, origin, to) => {
        gateway.team.push({ kind, origin, to })
        return { ok: true, leadName: 'Lead' }
      },
      teamStatus: async (origin, edges) => {
        gateway.status.push({ origin, edges })
        return edges.map(() => ({ known: true, name: 'Member' }))
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

type Attach = { owner?: string; allow?: RelayOp[]; features?: RelayFeature[] }

async function attach(relay: Relay, stateDir: string, name: string, gateway: FakeGateway, options: Attach = {}): Promise<RelayConnection> {
  const key = await enrollGateway(stateDir, name, { owner: options.owner })
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
    expect(teamAllows(lead, member, lookup)).toBe(true)
    expect(teamAllows(member, lead, lookup)).toBe(true)
    expect(teamAllows(stranger, lead, lookup)).toBe(false)
    expect(teamAllows(top, member, lookup)).toBe(false)
    expect(teamAllows(member, top, lookup)).toBe(false)
    expect(teamAllows(top, lead, lookup)).toBe(true)
    expect(teamAllows(member, lead, () => undefined)).toBe(false)
  })

  it('across owners sees team rows only, never an agent shared as none', () => {
    const lead = node('mac', 'tobias', { id: 'mac:L', name: 'Lead', accepts: ['dan:M'] })
    const member = node('dan', 'dan', { id: 'dan:M', name: 'Member', lead: 'mac:L' })
    const plain = node('dan', 'dan', { id: 'dan:P', name: 'Plain' })
    const lookup = (id: string) => (id === 'mac:L' ? lead : undefined)
    expect(teamAllows(lead, member, lookup)).toBe(true)
    expect(teamAllows(lead, plain, lookup)).toBe(false)
    expect(teamAllows(node('mac', 'tobias'), node('dan', 'dan'), lookup)).toBe(false)
    expect(teamAllows(lead, { ...member, agent: { ...member.agent!, share: 'none' } }, lookup)).toBe(false)
  })

  it('drops an agent id that names another gateway and qualifies the rest', () => {
    expect(sanitizeAgent('pi', { id: 'mac:L', name: 'Forged' })).toBeUndefined()
    expect(sanitizeAgent('pi', { id: 'M', name: 'Member', lead: 'mac:L', accepts: ['X', 'dan:Y'], share: 'bogus' })).toEqual({
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

    expect(await connPi.team('team.join', 'M', 'mac:L')).toEqual({ ok: true, leadName: 'Lead' })
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
    const answer = await connMac.teamStatus('pi', [
      { from: 'L', to: 'pi:M' },
      { from: 'L', to: 'pi:Z' },
      { from: 'L', to: 'mac:L' },
      { from: 'pi:forged', to: 'pi:M' },
    ])
    expect(answer).toEqual([{ from: 'L', to: 'pi:M', known: true, name: 'Member' }])
    expect(pi.status).toEqual([{ origin: { gateway: 'mac', owner: 'operator' }, edges: [{ from: 'mac:L', to: 'M' }] }])
    await expect(connMac.teamStatus('gone', [{ from: 'L', to: 'gone:M' }])).rejects.toThrow(/unreachable/)
  })
})
