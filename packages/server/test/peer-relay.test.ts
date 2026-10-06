import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runPeerTool } from '@workerdeck/core'
import { enrollGateway, startRelay, type Relay } from '@workerdeck/relay'
import { createRelayLink, type RelayLink, type RelayLinkOptions } from '../src/services/peer-relay.ts'
import { createPeerService, resolvePeerMentions } from '../src/services/peers.ts'
import { ProjectInfoService } from '../src/services/project-info.ts'
import { SessionRegistry } from '../src/services/registry.ts'
import type { AgentRef } from '@workerdeck/protocol'
import { PeerRunner } from './peer-runner.ts'

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

async function relayRig(): Promise<{ relay: Relay; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'wd-peer-relay-'))
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
  await writeFile(join(stateDir, 'rules.json'), JSON.stringify({ rules: [{ from: '*', to: '*' }] }))
  const relay = await startRelay({ stateDir, port: 0, log: () => {} })
  cleanups.push(() => relay.close())
  return { relay, stateDir }
}

async function gateway(
  relay: Relay,
  stateDir: string,
  name: string,
  runners: PeerRunner[],
  expose?: RelayLinkOptions['expose'],
  agents: Record<string, AgentRef> = {},
  teams: { accepts?: Record<string, string[]>; spans?: string[] } = {},
) {
  const key = await enrollGateway(stateDir, name)
  await relay.reload()
  const registry = new SessionRegistry()
  const projects = new ProjectInfoService({ decorate: (info) => (agents[info.id] ? { ...info, agent: agents[info.id] } : info) })
  const service = createPeerService({
    refs: { registry },
    projects,
    teams: {
      relayAgent: (id) => {
        const ref = agents[id]
        const accepts = teams.accepts?.[id]
        return ref ? { id: ref.id, name: ref.name, ...(ref.lead ? { lead: ref.lead } : {}), ...(accepts ? { accepts } : {}) } : undefined
      },
      spansGateways: (id) => teams.spans?.includes(id) === true,
      agentName: (agentId) => Object.values(agents).find((ref) => ref.id === agentId)?.name,
    },
  })
  registry.observe((runner) => service.watch(runner))
  for (const runner of runners) {
    registry.register(runner)
  }
  const link: RelayLink = createRelayLink({ url: relay.url, gateway: name, key, expose }, service, () => {})
  cleanups.push(() => link.close())
  const published = runners.filter(
    (runner) =>
      (!expose?.scope || runner.scope?.team === expose.scope.team) &&
      (agents[runner.id]?.lead === undefined || teams.spans?.includes(runner.id) === true),
  ).length
  await until(() => relay.status().gateways.find((row) => row.name === name)?.sessions === published, `${name} published`)
  return link
}

describe('peer relay link', () => {
  it('lists remote rows, delivers with a gateway-qualified origin, and carries the hop chain back', async () => {
    const { relay, stateDir } = await relayRig()
    const a1 = new PeerRunner('a1', { title: 'Astra' })
    const b1 = new PeerRunner('b1', { title: 'Bolt' })
    const mac = await gateway(relay, stateDir, 'mac', [a1, new PeerRunner('a2')])
    const pi = await gateway(relay, stateDir, 'pi', [b1])

    const rows = await mac.directory.list('a1')
    expect(rows.map((row) => row.id)).toEqual(['a2', 'pi:b1'])
    expect(rows[1]).toMatchObject({ gateway: 'pi', title: 'Bolt', cwd: '/work/b1', allow: ['send', 'peek'] })

    const sent = await runPeerTool(mac.directory, 'a1', 'peers_send', { sessionId: 'pi:b1', text: 'please review' })
    expect(sent.isError).toBe(false)
    expect(sent.text).toContain('pi:b1')
    expect(b1.sent).toEqual([
      {
        text: 'please review',
        options: { origin: { kind: 'peer', sessionId: 'mac:a1', hostId: 'mac', name: 'Astra', engine: 'claude', hops: ['mac:a1'] } },
      },
    ])

    expect((await pi.directory.send('b1', 'mac:a1', 'done')).delivered).toBe(true)
    expect(a1.sent[0]!.options?.origin).toMatchObject({ sessionId: 'pi:b1', hostId: 'pi', hops: ['mac:a1', 'pi:b1'] })

    const peek = await mac.directory.peek('a1', 'pi:b1')
    expect(peek).toMatchObject({ id: 'pi:b1', gateway: 'pi', live: true })
  })

  it('never publishes a session outside the ceiling and refuses ops the ceiling does not accept', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac', [new PeerRunner('a1')])
    const hidden = new PeerRunner('b2', { scope: { team: 'x' } })
    const open = new PeerRunner('b1', { scope: { team: 'ops' } })
    await gateway(relay, stateDir, 'pi', [open, hidden], { scope: { team: 'ops' }, allow: ['send'] })
    const rows = await mac.directory.list('a1')
    expect(rows.map((row) => [row.id, row.allow])).toEqual([['pi:b1', ['send']]])
    expect(await mac.directory.peek('a1', 'pi:b1')).toBeUndefined()
    expect(await mac.directory.send('a1', 'pi:b2', 'hi')).toEqual({ delivered: false, reason: 'no such session: pi:b2' })
    expect(hidden.sent).toEqual([])
  })

  it('keeps a scoped session on its own gateway', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac', [new PeerRunner('a1', { scope: { tenant: 't1' } })])
    await gateway(relay, stateDir, 'pi', [new PeerRunner('b1')])
    expect(await mac.directory.list('a1')).toEqual([])
    expect(await mac.directory.send('a1', 'pi:b1', 'hi')).toEqual({ delivered: false, reason: 'no such session: pi:b1' })
  })

  it('keeps team members on their own gateway, in both directions', async () => {
    const { relay, stateDir } = await relayRig()
    const team = {
      lead: { id: 'A', name: 'Atlas', avatar: '', leads: true as const },
      member: { id: 'P', name: 'Pip', avatar: '', lead: 'A', team: 'Atlas' },
    }
    const mac = await gateway(relay, stateDir, 'mac', [new PeerRunner('lead'), new PeerRunner('member')], undefined, team)
    const pi = await gateway(relay, stateDir, 'pi', [new PeerRunner('b1')])
    expect((await mac.directory.list('member')).map((row) => row.id)).toEqual(['lead'])
    expect(await mac.directory.send('member', 'pi:b1', 'hi')).toEqual({ delivered: false, reason: 'no such session: pi:b1' })
    expect((await mac.directory.list('lead')).map((row) => row.id)).toEqual(['member', 'pi:b1'])
    expect((await pi.directory.list('b1')).map((row) => row.id)).toEqual(['mac:lead'])
  })

  it('lets a team span gateways: a member reaches its lead and nothing else, and only team rows reach the member', async () => {
    const { relay, stateDir } = await relayRig()
    const leadRunner = new PeerRunner('lead', { title: 'Planning' })
    const memberRunner = new PeerRunner('member', { title: 'Windows build' })
    const outsiderRunner = new PeerRunner('outsider')
    const mac = await gateway(
      relay,
      stateDir,
      'mac',
      [leadRunner, new PeerRunner('plain')],
      undefined,
      { lead: { id: 'L', name: 'AC-Lead', leads: true } },
      { accepts: { lead: ['win:M'] } },
    )
    const win = await gateway(
      relay,
      stateDir,
      'win',
      [memberRunner, new PeerRunner('wplain')],
      undefined,
      { member: { id: 'M', name: 'MagWin', lead: 'mac:L', team: 'AC-Lead' } },
      { spans: ['member'] },
    )
    const pi = await gateway(
      relay,
      stateDir,
      'pi',
      [outsiderRunner, new PeerRunner('faker')],
      undefined,
      { faker: { id: 'F', name: 'Faker', lead: 'mac:L' } },
      { spans: ['faker'] },
    )
    const ids = async (link: RelayLink, from: string) => (await link.directory.list(from)).map((row) => row.id).sort()

    expect(await ids(win, 'member')).toEqual(['mac:lead'])
    expect((await win.directory.list('member'))[0]).toMatchObject({ agent: 'AC-Lead', role: 'lead', team: 'AC-Lead' })
    expect((await mac.directory.list('lead')).find((row) => row.id === 'win:member')).toMatchObject({
      agent: 'MagWin',
      role: 'member',
      team: 'AC-Lead',
    })
    expect(await ids(mac, 'plain')).toEqual(['lead', 'pi:outsider', 'win:wplain'])
    expect(await ids(win, 'wplain')).toEqual(['mac:lead', 'mac:plain', 'pi:outsider'])
    expect(await ids(pi, 'outsider')).toEqual(['mac:lead', 'mac:plain', 'win:wplain'])
    expect(await ids(pi, 'faker')).toEqual([])

    expect(resolvePeerMentions(await win.directory.list('member'), 'ask #AC-Lead')).toMatchObject([{ id: 'mac:lead', name: 'AC-Lead' }])
    expect((await win.directory.send('member', 'mac:lead', 'built')).delivered).toBe(true)
    expect(leadRunner.sent[0]!.options?.origin).toMatchObject({ sessionId: 'win:member', name: 'MagWin' })
    expect((await mac.directory.send('lead', 'win:member', 'thanks')).delivered).toBe(true)
    expect(await win.directory.send('member', 'mac:plain', 'hi')).toEqual({ delivered: false, reason: 'no such session: mac:plain' })
    expect(await win.directory.send('member', 'pi:outsider', 'hi')).toEqual({ delivered: false, reason: 'no such session: pi:outsider' })
    expect(await pi.directory.send('outsider', 'win:member', 'hi')).toEqual({ delivered: false, reason: 'no such session: win:member' })
    expect(await pi.directory.send('faker', 'win:member', 'hi')).toEqual({ delivered: false, reason: 'no such session: win:member' })
    expect(await mac.directory.peek('plain', 'win:member')).toBeUndefined()
    expect(memberRunner.sent.map((sent) => sent.text)).toEqual(['thanks'])
    expect(outsiderRunner.sent).toEqual([])
  })

  it('says remote gateways are unavailable instead of failing when the relay is gone', async () => {
    const { relay, stateDir } = await relayRig()
    const mac = await gateway(relay, stateDir, 'mac', [new PeerRunner('a1'), new PeerRunner('a2')])
    await relay.close()
    await until(async () => (await mac.directory.notice?.('a1')) !== undefined, 'offline notice')
    const listed = await runPeerTool(mac.directory, 'a1', 'peers_list', {})
    expect(listed.text).toContain('"a2"')
    expect(listed.text).toContain('Remote gateways are unavailable')
    expect((await mac.directory.send('a1', 'pi:b1', 'hi')).delivered).toBe(false)
  })

  it('hands the open connection to the next generation on release instead of reconnecting', async () => {
    const { relay, stateDir } = await relayRig()
    const key = await enrollGateway(stateDir, 'mac')
    await relay.reload()
    const service = (runners: PeerRunner[]) => {
      const registry = new SessionRegistry()
      runners.forEach((runner) => registry.register(runner))
      return createPeerService({ refs: { registry }, projects: new ProjectInfoService() })
    }
    const options = { url: relay.url, gateway: 'mac', key }
    const first = createRelayLink(options, service([new PeerRunner('a1')]), () => {})
    await until(() => relay.status().gateways.find((row) => row.name === 'mac')?.sessions === 1, 'first generation')
    const connectedAt = relay.status().gateways.find((row) => row.name === 'mac')!.connectedAt
    first.release()
    first.close()
    const second = createRelayLink(options, service([new PeerRunner('a1'), new PeerRunner('a2')]), () => {})
    cleanups.push(() => second.close())
    second.nudge()
    await until(() => relay.status().gateways.find((row) => row.name === 'mac')?.sessions === 2, 'second generation publishes')
    expect(relay.status().gateways.find((row) => row.name === 'mac')!.connectedAt).toBe(connectedAt)
  })

  it('dials fresh on release when the team policy changed, so edited acceptFrom is never adopted stale', async () => {
    const { relay, stateDir } = await relayRig()
    const key = await enrollGateway(stateDir, 'mac')
    await relay.reload()
    const registry = new SessionRegistry()
    registry.register(new PeerRunner('a1'))
    const service = createPeerService({ refs: { registry }, projects: new ProjectInfoService() })
    const first = createRelayLink({ url: relay.url, gateway: 'mac', key, teams: { acceptFrom: [] } }, service, () => {})
    await until(() => relay.status().gateways.find((row) => row.name === 'mac')?.sessions === 1, 'first generation')
    const connectedAt = relay.status().gateways.find((row) => row.name === 'mac')!.connectedAt
    first.release()
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = createRelayLink({ url: relay.url, gateway: 'mac', key, teams: { acceptFrom: ['win'] } }, service, () => {})
    cleanups.push(() => second.close())
    await until(() => (relay.status().gateways.find((row) => row.name === 'mac')?.connectedAt ?? connectedAt) !== connectedAt, 'a fresh dial')
  })
})
