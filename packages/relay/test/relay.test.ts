import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
import { rateLimiter, sendRefusal } from '../src/limits.ts'
import { startRelay, type Relay, type RelayOptions } from '../src/relay.ts'
import { fetchRelayStatus, statusSocketPath } from '../src/status.ts'

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

async function setup(
  rules: unknown = { rules: [{ from: '*', to: '*' }] },
  options: Partial<RelayOptions> = {},
): Promise<{ stateDir: string; relay: Relay; enroll: (name: string) => Promise<string> }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-'))
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
  await writeFile(join(stateDir, 'rules.json'), JSON.stringify(rules))
  const relay = await startRelay({ stateDir, port: 0, log: () => {}, watchIntervalMs: 60_000, heartbeatMs: 60_000, ...options })
  cleanups.push(() => relay.close())
  const enroll = async (name: string): Promise<string> => {
    const key = await enrollGateway(stateDir, name)
    await relay.reload()
    return key
  }
  return { stateDir, relay, enroll }
}

function logLine(match: RegExp): { log: (line: string) => void; seen: Promise<string> } {
  let found: (line: string) => void = () => {}
  const seen = new Promise<string>((resolve) => {
    found = resolve
  })
  return { log: (line) => match.test(line) && found(line), seen }
}

async function connectGateway(
  relay: Relay,
  name: string,
  key: string,
  gateway: FakeGateway,
  allow?: RelayOp[],
  log?: (line: string) => void,
): Promise<RelayConnection> {
  const connection = connectRelay(
    { url: relay.url, gateway: name, key, allow, tickMs: 30, digestMs: 60_000, backoffMinMs: 20, backoffMaxMs: 100, log },
    gateway.host,
  )
  cleanups.push(() => connection.close())
  await until(() => connection.state() === 'online', `${name} online`)
  await until(() => relay.status().gateways.find((row) => row.name === name)?.sessions === gateway.entries.length, `${name} snapshot`)
  return connection
}

describe('relay', () => {
  it('lists, peeks and sends across two gateways with a relay-stamped origin', async () => {
    const { relay, enroll } = await setup()
    const a = fakeGateway([
      entry('a1', { title: 'Astra', model: 'opus', contextUsage: { totalTokens: 10, maxTokens: 100, percentage: 10 } }),
    ])
    const b = fakeGateway([entry('b1', { title: 'Bolt', project: { name: 'srv', root: '/srv' } })])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    await connectGateway(relay, 'pi', await enroll('pi'), b)

    const rows = await connA.list('a1')
    expect(rows).toEqual([
      expect.objectContaining({ gateway: 'pi', id: 'b1', title: 'Bolt', project: { name: 'srv', root: '/srv' }, allow: ['send', 'peek'] }),
    ])

    const peek = await connA.peek('a1', { gateway: 'pi', id: 'b1' }, 4)
    expect(peek?.recent).toEqual(['assistant: hi'])

    const result = await connA.send('a1', { gateway: 'pi', id: 'b1' }, 'hello', ['a0'])
    expect(result).toEqual({ delivered: true, sessionId: 'b1', queued: false })
    expect(b.sent).toEqual([
      { origin: { gateway: 'mac', owner: 'operator', sessionId: 'a1', name: 'Astra', hops: ['mac:a0'] }, to: 'b1', text: 'hello' },
    ])
  })

  it('denies by default and answers every miss the same way', async () => {
    const { relay, enroll } = await setup({ rules: [] })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    await connectGateway(relay, 'pi', await enroll('pi'), b)
    expect(await connA.list('a1')).toEqual([])
    expect(await connA.peek('a1', { gateway: 'pi', id: 'b1' })).toBeUndefined()
    const denied = await connA.send('a1', { gateway: 'pi', id: 'b1' }, 'hi', [])
    const missing = await connA.send('a1', { gateway: 'nope', id: 'x' }, 'hi', [])
    expect(denied).toEqual({ delivered: false, reason: 'no such session: pi:b1' })
    expect(missing).toEqual({ delivered: false, reason: 'no such session: nope:x' })
    expect(b.sent).toEqual([])
  })

  it('a rule without allow permits peek; the gateway ceiling beats the rule', async () => {
    const { relay, enroll } = await setup({ rules: [{ from: 'mac', to: 'pi' }] })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    await connectGateway(relay, 'pi', await enroll('pi'), b, ['send'])
    expect((await connA.list('a1')).map((row) => row.allow)).toEqual([['send']])
    expect(await connA.peek('a1', { gateway: 'pi', id: 'b1' })).toBeUndefined()
    expect(b.peeks).toEqual([])
  })

  it('scopes a rule to project paths', async () => {
    const { relay, enroll } = await setup({ rules: [{ from: '*', to: '*', scope: { projects: ['/srv/ci'] } }] })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1', { cwd: '/srv/ci/web' }), entry('b2', { cwd: '/srv/cia' })])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    await connectGateway(relay, 'pi', await enroll('pi'), b)
    expect((await connA.list('a1')).map((row) => row.id)).toEqual(['b1'])
  })

  it('refuses a sender session the gateway never published', async () => {
    const { relay, enroll } = await setup()
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    await connectGateway(relay, 'pi', await enroll('pi'), b)
    expect(await connA.list('hidden')).toEqual([])
    expect((await connA.send('hidden', { gateway: 'pi', id: 'b1' }, 'hi', [])).delivered).toBe(false)
  })

  it('converges a delete within a tick and clears a gateway on disconnect', async () => {
    const { relay, enroll } = await setup()
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1'), entry('b2')])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    const connB = await connectGateway(relay, 'pi', await enroll('pi'), b)
    b.entries = [entry('b2', { status: 'running' })]
    await until(async () => JSON.stringify((await connA.list('a1')).map((row) => [row.id, row.status])) === '[["b2","running"]]', 'delta')
    connB.close()
    await until(async () => (await connA.list('a1')).length === 0, 'clear on drop')
    expect(relay.status().gateways.find((row) => row.name === 'pi')?.online).toBe(false)
  })

  it('refuses an empty, an oversized, a too-many-hops and an over-the-rate send over the wire', async () => {
    const { relay, enroll } = await setup({ rules: [{ from: '*', to: '*' }] }, { perMinute: 2, maxHops: 2, maxMessageChars: 10 })
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    await connectGateway(relay, 'pi', await enroll('pi'), b)
    const to = { gateway: 'pi', id: 'b1' }
    expect(await connA.send('a1', to, 'x'.repeat(11), [])).toEqual({
      delivered: false,
      reason: sendRefusal('x'.repeat(11), 0, { maxChars: 10, maxHops: 2 }),
    })
    expect(await connA.send('a1', to, 'x', ['a', 'b', 'c'])).toEqual({
      delivered: false,
      reason: sendRefusal('x', 3, { maxChars: 10, maxHops: 2 }),
    })
    expect((await connA.send('a1', to, 'one', [])).delivered).toBe(true)
    expect((await connA.send('a1', to, 'two', [])).delivered).toBe(true)
    const third = await connA.send('a1', to, 'three', [])
    expect(third.delivered === false && third.reason).toMatch(/rate limit: at most 2 messages a minute/)
    expect(b.sent.map((row) => row.text)).toEqual(['one', 'two'])
  })

  it('refuses a wrong key, a bad version and a missing hello', async () => {
    const { relay, enroll } = await setup()
    await enroll('mac')
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
  })

  it('drops a revoked gateway: its link closes as revoked and nothing routes to it', async () => {
    const { stateDir, relay, enroll } = await setup()
    const a = fakeGateway([entry('a1')])
    const b = fakeGateway([entry('b1')])
    const connA = await connectGateway(relay, 'mac', await enroll('mac'), a)
    const revoked = logLine(/not enrolled at the relay/)
    const connB = await connectGateway(relay, 'pi', await enroll('pi'), b, undefined, revoked.log)
    await revokeGateway(stateDir, 'pi')
    await relay.reload()
    expect(relay.status().gateways.map((row) => row.name)).toEqual(['mac'])
    expect(await revoked.seen).toMatch(/\(revoked\)/)
    expect(connB.state()).not.toBe('online')
    expect(await connA.list('a1')).toEqual([])
    expect(await connA.send('a1', { gateway: 'pi', id: 'b1' }, 'hi', [])).toEqual({ delivered: false, reason: 'no such session: pi:b1' })
    expect(b.sent).toEqual([])
  })

  it('follows enrollment and revocation from the file watcher, without a reload', async () => {
    const { stateDir, relay } = await setup(undefined, { watchIntervalMs: 50 })
    const revoked = logLine(/not enrolled at the relay/)
    const connB = await connectGateway(relay, 'pi', await enrollGateway(stateDir, 'pi'), fakeGateway([entry('b1')]), undefined, revoked.log)
    await revokeGateway(stateDir, 'pi')
    expect(await revoked.seen).toMatch(/\(revoked\)/)
    expect(connB.state()).not.toBe('online')
    expect(relay.status().gateways.map((row) => row.name)).toEqual([])
  })

  it('asks for a snapshot when a delta skips a seq', async () => {
    const { relay, enroll } = await setup()
    const key = await enroll('raw')
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

  it('answers status on the state dir socket only, and once per state dir', async () => {
    const { stateDir, relay, enroll } = await setup()
    await connectGateway(relay, 'mac', await enroll('mac'), fakeGateway([entry('a1')]))
    expect((await fetchRelayStatus(stateDir)).gateways).toEqual([expect.objectContaining({ name: 'mac', online: true, sessions: 1 })])
    expect((await fetch(`http://127.0.0.1:${relay.port}/status`)).status).toBe(404)
    await expect(startRelay({ stateDir, port: 0, log: () => {} })).rejects.toThrow(/already serving/)
    await relay.close()
    await expect(stat(statusSocketPath(stateDir))).rejects.toThrow(/ENOENT/)
    await expect(fetchRelayStatus(stateDir)).rejects.toThrow()
  })

  it('replaces a stale status socket left by a crashed relay', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wd-relay-'))
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
    await writeFile(statusSocketPath(stateDir), '')
    const relay = await startRelay({ stateDir, port: 0, log: () => {} })
    cleanups.push(() => relay.close())
    expect((await fetchRelayStatus(stateDir)).gateways).toEqual([])
  })

  it('reconnects and republishes after the relay restarts', async () => {
    const { stateDir, relay, enroll } = await setup()
    const a = fakeGateway([entry('a1')])
    const conn = await connectGateway(relay, 'mac', await enroll('mac'), a)
    const port = relay.port
    await relay.close()
    await until(() => conn.state() !== 'online', 'offline')
    await expect(conn.list('a1')).rejects.toThrow(/unavailable/)
    const again = await startRelay({ stateDir, port, log: () => {} })
    cleanups.push(() => again.close())
    await until(() => again.status().gateways.find((row) => row.name === 'mac')?.sessions === 1, 'republish', 8_000)
  })
})

describe('send limits (pure)', () => {
  const limits = { maxChars: 10, maxHops: 2 }

  it.each([
    ['an empty message', '', 0, /message is 0 characters; the limit is 10/],
    ['a message one over the size', 'x'.repeat(11), 0, /message is 11 characters; the limit is 10/],
    ['one hop too many', 'x', 3, /^3 messages have passed between sessions/],
    ['an oversized message with too many hops, by size first', 'x'.repeat(11), 3, /message is 11 characters/],
  ])('refuses %s', (_label, text, hops, reason) => {
    expect(sendRefusal(text, hops, limits)).toMatch(reason)
  })

  it('takes a message at exactly the size and hop limits', () => {
    expect(sendRefusal('x'.repeat(10), 2, limits)).toBeUndefined()
  })

  it('admits up to the limit per key inside the window, and again once the oldest send leaves it', () => {
    let now = 1_000
    const admit = rateLimiter(() => now)
    expect([admit('a->b', 2, 60_000), admit('a->b', 2, 60_000), admit('a->b', 2, 60_000)]).toEqual([true, true, false])
    expect(admit('a->c', 2, 60_000)).toBe(true)
    now = 1_000 + 59_999
    expect(admit('a->b', 2, 60_000)).toBe(false)
    now = 1_000 + 60_000
    expect(admit('a->b', 2, 60_000)).toBe(true)
    expect(admit('a->b', 2, 60_000)).toBe(true)
    expect(admit('a->b', 2, 60_000)).toBe(false)
  })

  it('does not count a refused send against the window', () => {
    let now = 0
    const admit = rateLimiter(() => now)
    admit('k', 1, 1_000)
    now = 500
    expect(admit('k', 1, 1_000)).toBe(false)
    now = 1_000
    expect(admit('k', 1, 1_000)).toBe(true)
  })
})
