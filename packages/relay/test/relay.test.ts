import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  RELAY_CLOSE,
  RELAY_WIRE_VERSION,
  connectRelay,
  type RelayConnection,
  type RelayHost,
  type RelayOp,
  type RelayOrigin,
  type RelaySessionEntry,
} from '@workerdeck/relay-client'
import { enrollGateway, revokeGateway } from '../src/enrollment.ts'
import { startRelay, type Relay } from '../src/relay.ts'

type FakeGateway = {
  entries: RelaySessionEntry[]
  sent: Array<{ origin: RelayOrigin; to: string; text: string }>
  peeks: Array<{ origin: RelayOrigin; to: string }>
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
    sent: [],
    peeks: [],
    host: {
      snapshot: async () => gateway.entries,
      peek: async (origin, to) => {
        gateway.peeks.push({ origin, to })
        const found = gateway.entries.find((row) => row.id === to)
        return found ? { ...found, pendingApprovals: [], recent: ['assistant: hi'] } : undefined
      },
      send: async (origin, to, text) => {
        gateway.sent.push({ origin, to, text })
        return { delivered: true, sessionId: to, queued: false }
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

async function setup(rules: unknown = { rules: [{ from: '*', to: '*' }] }): Promise<{ stateDir: string; relay: Relay }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-'))
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
  await writeFile(join(stateDir, 'rules.json'), JSON.stringify(rules))
  const relay = await startRelay({ stateDir, port: 0, log: () => {}, watchIntervalMs: 50, heartbeatMs: 60_000 })
  cleanups.push(() => relay.close())
  return { stateDir, relay }
}

async function connectGateway(relay: Relay, name: string, key: string, gateway: FakeGateway, allow?: RelayOp[]): Promise<RelayConnection> {
  const connection = connectRelay(
    { url: relay.url, gateway: name, key, allow, tickMs: 30, digestMs: 60_000, backoffMinMs: 20, backoffMaxMs: 100 },
    gateway.host,
  )
  cleanups.push(() => connection.close())
  await until(() => connection.state() === 'online', `${name} online`)
  await until(() => relay.status().gateways.find((row) => row.name === name)?.sessions === gateway.entries.length, `${name} snapshot`)
  return connection
}

describe('relay', () => {
  it('lists, peeks and sends across two gateways with a relay-stamped origin', async () => {
    const { stateDir, relay } = await setup()
    const a = fakeGateway([
      entry('a1', { title: 'Astra', model: 'opus', contextUsage: { totalTokens: 10, maxTokens: 100, percentage: 10 } }),
    ])
    const b = fakeGateway([entry('b1', { title: 'Bolt', project: { name: 'srv', root: '/srv' } })])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b)

    const rows = await connA.list('a1')
    expect(rows).toEqual([
      expect.objectContaining({ gateway: 'pi', id: 'b1', title: 'Bolt', project: { name: 'srv', root: '/srv' }, allow: ['send', 'peek'] }),
    ])

    const peek = await connA.peek('a1', { gateway: 'pi', id: 'b1' }, 4)
    expect(peek?.recent).toEqual(['assistant: hi'])

    const result = await connA.send('a1', { gateway: 'pi', id: 'b1' }, 'hello', ['a0'])
    expect(result).toEqual({ delivered: true, sessionId: 'b1', queued: false })
    expect(b.sent).toEqual([{ origin: { gateway: 'mac', sessionId: 'a1', name: 'Astra', hops: ['mac:a0'] }, to: 'b1', text: 'hello' }])
  })

  it('denies by default and answers every miss the same way', async () => {
    const { stateDir, relay } = await setup({ rules: [] })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b)
    expect(await connA.list('a1')).toEqual([])
    expect(await connA.peek('a1', { gateway: 'pi', id: 'b1' })).toBeUndefined()
    const denied = await connA.send('a1', { gateway: 'pi', id: 'b1' }, 'hi', [])
    const missing = await connA.send('a1', { gateway: 'nope', id: 'x' }, 'hi', [])
    expect(denied).toEqual({ delivered: false, reason: 'no such session: pi:b1' })
    expect(missing).toEqual({ delivered: false, reason: 'no such session: nope:x' })
    expect(b.sent).toEqual([])
  })

  it('a rule without allow permits peek; the gateway ceiling beats the rule', async () => {
    const { stateDir, relay } = await setup({ rules: [{ from: 'mac', to: 'pi' }] })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b, ['send'])
    expect((await connA.list('a1')).map((row) => row.allow)).toEqual([['send']])
    expect(await connA.peek('a1', { gateway: 'pi', id: 'b1' })).toBeUndefined()
    expect(b.peeks).toEqual([])
  })

  it('scopes a rule to project paths', async () => {
    const { stateDir, relay } = await setup({ rules: [{ from: '*', to: '*', scope: { projects: ['/srv/ci'] } }] })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1', { cwd: '/srv/ci/web' }), entry('b2', { cwd: '/srv/cia' })])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b)
    expect((await connA.list('a1')).map((row) => row.id)).toEqual(['b1'])
  })

  it('refuses a sender session the gateway never published', async () => {
    const { stateDir, relay } = await setup()
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b)
    expect(await connA.list('hidden')).toEqual([])
    expect((await connA.send('hidden', { gateway: 'pi', id: 'b1' }, 'hi', [])).delivered).toBe(false)
  })

  it('converges a delete within a tick and clears a gateway on disconnect', async () => {
    const { stateDir, relay } = await setup()
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1'), entry('b2')])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    const connB = await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b)
    b.entries = [entry('b2', { status: 'running' })]
    await until(async () => JSON.stringify((await connA.list('a1')).map((row) => [row.id, row.status])) === '[["b2","running"]]', 'delta')
    connB.close()
    await until(async () => (await connA.list('a1')).length === 0, 'clear on drop')
    expect(relay.status().gateways.find((row) => row.name === 'pi')?.online).toBe(false)
  })

  it('enforces hops, size and rate limits', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-'))
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
    await writeFile(join(stateDir, 'rules.json'), JSON.stringify({ rules: [{ from: '*', to: '*' }] }))
    const relay = await startRelay({ stateDir, port: 0, log: () => {}, perMinute: 2, maxHops: 2, maxMessageChars: 10 })
    cleanups.push(() => relay.close())
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), b)
    const to = { gateway: 'pi', id: 'b1' }
    expect((await connA.send('a1', to, 'x'.repeat(11), [])).delivered).toBe(false)
    expect((await connA.send('a1', to, 'x', ['a', 'b', 'c'])).delivered).toBe(false)
    expect((await connA.send('a1', to, 'one', [])).delivered).toBe(true)
    expect((await connA.send('a1', to, 'two', [])).delivered).toBe(true)
    const third = await connA.send('a1', to, 'three', [])
    expect(third.delivered === false && third.reason).toMatch(/rate limit/)
  })

  it('refuses a wrong key, a bad version and a missing hello, and drops a revoked gateway', async () => {
    const { stateDir, relay } = await setup()
    await enrollGateway(stateDir, 'mac')
    const closeOf = (frames: unknown[]): Promise<number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(relay.url)
        ws.on('open', () => frames.forEach((frame) => ws.send(JSON.stringify(frame))))
        ws.on('close', (code) => resolve(code))
      })
    expect(await closeOf([{ t: 'hello', gateway: 'mac', key: 'wrong', version: RELAY_WIRE_VERSION, ceiling: { ops: [] } }])).toBe(
      RELAY_CLOSE.unauthorized,
    )
    expect(await closeOf([{ t: 'hello', gateway: 'mac', key: 'x', version: 999, ceiling: { ops: [] } }])).toBe(RELAY_CLOSE.versionMismatch)
    expect(await closeOf([{ t: 'peer.list', id: '1', from: 'x' }])).toBe(RELAY_CLOSE.badHello)

    const b = fakeGateway([entry('b1')])
    const key = await enrollGateway(stateDir, 'pi')
    const connB = await connectGateway(relay, 'pi', key, b)
    await revokeGateway(stateDir, 'pi')
    await until(() => relay.status().gateways.every((row) => row.name !== 'pi'), 'revocation')
    expect(connB.state()).not.toBe('online')
  })

  it('asks for a snapshot when a delta skips a seq', async () => {
    const { stateDir, relay } = await setup()
    const key = await enrollGateway(stateDir, 'raw')
    await relay.reload()
    const ws = new WebSocket(relay.url)
    cleanups.push(() => ws.terminate())
    const frames: Array<{ t: string }> = []
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
    await new Promise((resolve) => ws.on('open', resolve))
    ws.send(JSON.stringify({ t: 'hello', gateway: 'raw', key, version: RELAY_WIRE_VERSION, ceiling: { ops: ['send'] } }))
    ws.send(JSON.stringify({ t: 'registry.snapshot', seq: 1, entries: [entry('r1')] }))
    ws.send(JSON.stringify({ t: 'registry.delta', seq: 3, upsert: [], remove: ['r1'] }))
    await until(() => frames.some((frame) => frame.t === 'registry.resync'), 'resync')
    expect(relay.status().gateways.find((row) => row.name === 'raw')?.sessions).toBe(1)
    ws.send(JSON.stringify({ t: 'registry.digest', seq: 1, count: 1, hash: 'bogus' }))
    await until(() => frames.filter((frame) => frame.t === 'registry.resync').length === 2, 'digest resync')
  })

  it('reconnects and republishes after the relay restarts', async () => {
    const { stateDir, relay } = await setup()
    const a = fakeGateway([entry('a1')])
    const conn = await connectGateway(relay, 'mac', await enrollGateway(stateDir, 'mac'), a)
    const port = relay.port
    await relay.close()
    await until(() => conn.state() !== 'online', 'offline')
    await expect(conn.list('a1')).rejects.toThrow(/unavailable/)
    const again = await startRelay({ stateDir, port, log: () => {} })
    cleanups.push(() => again.close())
    await until(() => again.status().gateways.find((row) => row.name === 'mac')?.sessions === 1, 'republish', 8_000)
  })
})
