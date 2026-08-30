import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants, createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2'
import { join } from 'node:path'
import type { SessionNotification } from '@workerdeck/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import { type ApnsConfig, type ApnsEnvironment, createApnsClient, createProviderToken } from '../src/apns/client.ts'
import { createDeviceRegistry, createDeviceRoute } from '../src/apns/devices.ts'
import { buildPush } from '../src/apns/forwarder.ts'

const created: string[] = []
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-apns-'))
  created.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A stand-in for the `.p8`: same curve, same PKCS#8 PEM shape, no Apple. */
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const KEY = createPrivateKey(KEY_PEM)

const CONFIG: ApnsConfig = {
  keyFile: 'unused.p8',
  keyId: 'ABCD123456',
  teamId: 'TEAM123456',
  topic: 'bi.atomic.workerdeck.ios',
}

const TOKEN = 'a'.repeat(64)

describe('provider token', () => {
  it('signs ES256 as a raw r||s pair, not the DER sequence node defaults to', () => {
    // The failure this guards: `sign()` without `dsaEncoding` produces a DER
    // SEQUENCE, JWS requires the concatenated pair, and Apple's answer to the
    // difference is a bare 403 with nothing to debug from.
    const jwt = createProviderToken(KEY, CONFIG.keyId, CONFIG.teamId).get()
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: CONFIG.keyId,
    })
    const decoded = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { iss: string }
    expect(decoded.iss).toBe(CONFIG.teamId)
    const raw = Buffer.from(signature!, 'base64url')
    expect(raw.byteLength).toBe(64)
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true)
  })

  it('reuses one token rather than re-signing per push', () => {
    // Apple rate-limits provider-token refreshes; re-signing per push is what
    // earns `TooManyProviderTokenUpdates`.
    const token = createProviderToken(KEY, CONFIG.keyId, CONFIG.teamId)
    const first = token.get(1_000_000)
    expect(token.get(1_000_000 + 60_000)).toBe(first)
    expect(token.get(1_000_000 + 45 * 60_000)).not.toBe(first)
  })
})

/** A local HTTP/2 server standing in for APNs, so the request line, the headers
 * and the error classification are exercised for real rather than mocked. */
type Recorded = { headers: Record<string, unknown>; body: string }
const startFakeApns = async (
  respond: (recorded: Recorded, stream: ServerHttp2Stream) => void,
): Promise<{ server: Http2Server; hosts: Record<ApnsEnvironment, string>; seen: Recorded[] }> => {
  const seen: Recorded[] = []
  const server = createServer()
  server.on('stream', (stream, headers) => {
    // Closing a server stream with an RST code errors the server's own stream
    // object too; without a listener that would take the test process down.
    stream.on('error', () => {})
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      const recorded = { headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(recorded)
      respond(recorded, stream)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const url = `http://127.0.0.1:${port}`
  return { server, hosts: { development: url, production: url }, seen }
}

describe('apns client', () => {
  it('posts to /3/device/<token> with the topic and push-type headers', async () => {
    const fake = await startFakeApns((_recorded, stream) => {
      stream.respond({ ':status': 200, 'apns-id': 'id-1' })
      stream.end()
    })
    const client = createApnsClient(CONFIG, KEY, { hosts: fake.hosts })
    const result = await client.send({
      deviceToken: TOKEN,
      environment: 'development',
      payload: { aps: { alert: 'hi' } },
      collapseId: 'c1',
      priority: 5,
    })
    client.close()
    expect(result).toEqual({ ok: true, apnsId: 'id-1' })
    const sent = fake.seen[0]!
    expect(sent.headers[':path']).toBe(`/3/device/${TOKEN}`)
    expect(sent.headers['apns-topic']).toBe(CONFIG.topic)
    expect(sent.headers['apns-push-type']).toBe('alert')
    expect(sent.headers['apns-priority']).toBe('5')
    expect(sent.headers['apns-collapse-id']).toBe('c1')
    expect(String(sent.headers.authorization)).toMatch(/^bearer ey/)
    expect(JSON.parse(sent.body)).toEqual({ aps: { alert: 'hi' } })
    await new Promise((resolve) => fake.server.close(resolve))
  })

  it('flags a dead token so the registry can drop it', async () => {
    const fake = await startFakeApns((_recorded, stream) => {
      stream.respond({ ':status': 410 })
      stream.end(JSON.stringify({ reason: 'Unregistered' }))
    })
    const client = createApnsClient(CONFIG, KEY, { hosts: fake.hosts })
    const result = await client.send({
      deviceToken: TOKEN,
      environment: 'production',
      payload: {},
    })
    client.close()
    expect(result).toEqual({ ok: false, status: 410, reason: 'Unregistered', unregistered: true })
    await new Promise((resolve) => fake.server.close(resolve))
  })

  it('treats BadDeviceToken as dead too — it is the environment mismatch', async () => {
    const fake = await startFakeApns((_recorded, stream) => {
      stream.respond({ ':status': 400 })
      stream.end(JSON.stringify({ reason: 'BadDeviceToken' }))
    })
    const client = createApnsClient(CONFIG, KEY, { hosts: fake.hosts })
    const result = await client.send({ deviceToken: TOKEN, environment: 'production', payload: {} })
    client.close()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.unregistered).toBe(true)
    }
    await new Promise((resolve) => fake.server.close(resolve))
  })

  it('reports why the connection died, not just that the stream was canceled', async () => {
    // A stream that never left the queue reports only ERR_HTTP2_STREAM_CANCEL,
    // which is useless for telling a DNS failure from a TLS problem from APNs
    // hanging up on a throttled client. The session knows; the result must say.
    const dead = await startFakeApns(() => {})
    const { port } = dead.server.address() as { port: number }
    await new Promise((resolve) => dead.server.close(resolve))
    const url = `http://127.0.0.1:${port}`
    const client = createApnsClient(CONFIG, KEY, {
      hosts: { development: url, production: url },
      retryDelayMs: 0,
    })
    const result = await client.send({
      deviceToken: TOKEN,
      environment: 'development',
      payload: {},
    })
    client.close()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('ECONNREFUSED')
      expect(result.unregistered).toBe(false)
    }
  })

  it('names the refusal even when every address family fails at once', async () => {
    // The production failure this pins: a fresh dial to api.push.apple.com
    // (A + AAAA records) fails on every family, net aggregates the attempts
    // into an AggregateError whose own message is EMPTY, and the gateway
    // logged "The pending stream has been canceled (caused by: ) (0)" — a
    // lost push with nothing to debug from. `localhost` resolves to both
    // families here too, so the same shape reproduces locally; on a
    // v4-only resolver this degrades to the single-error case, which the
    // test above already pins.
    const probe = await startFakeApns(() => {})
    const { port } = probe.server.address() as { port: number }
    await new Promise((resolve) => probe.server.close(resolve))
    const url = `http://localhost:${port}`
    const client = createApnsClient(CONFIG, KEY, {
      hosts: { development: url, production: url },
      retryDelayMs: 0,
    })
    const result = await client.send({ deviceToken: TOKEN, environment: 'development', payload: {} })
    client.close()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(0)
      expect(result.reason).toContain('ECONNREFUSED')
      expect(result.unregistered).toBe(false)
    }
  })

  it('redials and delivers a push whose first dial never connected', async () => {
    // The stream was still pending — its HEADERS frame never reached the
    // transport — so a retry cannot duplicate anything, and losing the push
    // is the only alternative. The server comes back between the attempts,
    // standing in for a network blip passing.
    const fake = await startFakeApns((_recorded, stream) => {
      stream.respond({ ':status': 200, 'apns-id': 'id-redial' })
      stream.end()
    })
    const { port } = fake.server.address() as { port: number }
    await new Promise((resolve) => fake.server.close(resolve))
    const url = `http://localhost:${port}`
    const client = createApnsClient(CONFIG, KEY, {
      hosts: { development: url, production: url },
      retryDelayMs: 400,
    })
    // The first attempt fails in milliseconds (local refusal); the server is
    // back well inside the 400ms redial pause.
    setTimeout(() => fake.server.listen(port), 100)
    const result = await client.send({
      deviceToken: TOKEN,
      environment: 'development',
      payload: { aps: { alert: 'hi' } },
    })
    client.close()
    expect(result).toEqual({ ok: true, apnsId: 'id-redial' })
    // The first attempt never connected, so the server saw exactly one push.
    expect(fake.seen).toHaveLength(1)
    await new Promise((resolve) => fake.server.close(resolve))
  })

  it('retries once when APNs refused the stream before processing it', async () => {
    // REFUSED_STREAM is the routine GOAWAY-rebalance race: Apple guarantees
    // the stream was not processed, so the retry is duplicate-safe and rides
    // the same client — before this, the push was silently dropped.
    let calls = 0
    const fake = await startFakeApns((_recorded, stream) => {
      calls += 1
      if (calls === 1) {
        stream.close(constants.NGHTTP2_REFUSED_STREAM)
        return
      }
      stream.respond({ ':status': 200, 'apns-id': 'id-retry' })
      stream.end()
    })
    const client = createApnsClient(CONFIG, KEY, { hosts: fake.hosts })
    const result = await client.send({ deviceToken: TOKEN, environment: 'production', payload: {} })
    client.close()
    expect(result).toEqual({ ok: true, apnsId: 'id-retry' })
    expect(calls).toBe(2)
    await new Promise((resolve) => fake.server.close(resolve))
  })

  it('does not retry a stream Apple may already have processed', async () => {
    // Anything other than "provably never sent" risks a duplicate
    // notification — permission requests carry no collapse id on purpose, so
    // a duplicate is a real second banner on someone's lock screen. An
    // INTERNAL_ERROR reset after the request went up gives no such proof.
    let calls = 0
    const fake = await startFakeApns((_recorded, stream) => {
      calls += 1
      if (calls === 1) {
        stream.close(constants.NGHTTP2_INTERNAL_ERROR)
        return
      }
      stream.respond({ ':status': 200 })
      stream.end()
    })
    const client = createApnsClient(CONFIG, KEY, { hosts: fake.hosts, retryDelayMs: 0 })
    const result = await client.send({ deviceToken: TOKEN, environment: 'production', payload: {} })
    client.close()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(0)
      expect(result.reason).toContain('NGHTTP2_INTERNAL_ERROR')
    }
    expect(calls).toBe(1)
    await new Promise((resolve) => fake.server.close(resolve))
  })

  it('re-signs and retries exactly once on ExpiredProviderToken', async () => {
    let calls = 0
    const fake = await startFakeApns((_recorded, stream) => {
      calls += 1
      if (calls === 1) {
        stream.respond({ ':status': 403 })
        stream.end(JSON.stringify({ reason: 'ExpiredProviderToken' }))
        return
      }
      stream.respond({ ':status': 200 })
      stream.end()
    })
    const client = createApnsClient(CONFIG, KEY, { hosts: fake.hosts })
    const result = await client.send({ deviceToken: TOKEN, environment: 'production', payload: {} })
    client.close()
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    await new Promise((resolve) => fake.server.close(resolve))
  })
})

const session = {
  id: 'sess_1',
  status: 'running',
  cwd: '/Users/me/projects/workerdeck',
  createdAt: 0,
  lastSeq: 7,
} as unknown as SessionNotification['session']

const notification = (over: Partial<SessionNotification>): SessionNotification =>
  ({ type: 'turn_completed', sessionId: 'sess_1', session, seq: 7, ts: 0, ...over }) as SessionNotification

describe('buildPush', () => {
  it('carries requestId and the permission category, and never collapses', () => {
    const push = buildPush(
      notification({
        type: 'permission_requested',
        preview: 'Claude wants to edit index.ts',
        request: { id: 'req_9', toolName: 'Edit', expiresAt: 5_000_000 } as never,
      }),
      'host-a',
    )
    const payload = push.payload as Record<string, unknown>
    expect(payload.requestId).toBe('req_9')
    expect(payload.hostId).toBe('host-a')
    expect((payload.aps as Record<string, unknown>).category).toBe('PERMISSION_REQUEST')
    // Each request is a distinct question the operator still owes an answer to;
    // collapsing would silently drop one.
    expect(push.collapseId).toBeUndefined()
    expect(push.priority).toBe(10)
    expect(push.expiration).toBe(5000)
  })

  it('collapses turn_completed per session', () => {
    const first = buildPush(notification({ preview: 'done' }), undefined)
    const other = buildPush(notification({ sessionId: 'sess_2', preview: 'done' }), undefined)
    expect(first.collapseId).toBeDefined()
    expect(first.collapseId!.length).toBeLessThanOrEqual(64)
    expect(first.collapseId).not.toBe(other.collapseId)
  })

  it('shrinks the body rather than blowing the 4 KB cap', () => {
    const push = buildPush(notification({ preview: 'x'.repeat(20_000) }), 'host-a')
    expect(Buffer.byteLength(JSON.stringify(push.payload))).toBeLessThan(4096)
  })

  it('falls back to the cwd leaf when the session has no title', () => {
    const push = buildPush(notification({ type: 'session_error', preview: 'boom' }), undefined)
    const aps = (push.payload as { aps: { alert: { title: string; body: string } } }).aps
    expect(aps.alert.title).toBe('Session error — workerdeck')
    expect(aps.alert.body).toBe('boom')
  })
})

describe('device registry', () => {
  it('persists at 0600 and survives a restart', async () => {
    const dir = await tempDir()
    const registry = await createDeviceRegistry({ dir })
    await registry.register({ token: TOKEN, environment: 'development', hostId: 'host-a' })
    const path = join(dir, 'apns-devices.json')
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    const reopened = await createDeviceRegistry({ dir })
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0]!.hostId).toBe('host-a')
  })

  it('starts empty on a corrupt file rather than refusing to boot', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'apns-devices.json'), 'not json at all')
    expect((await createDeviceRegistry({ dir })).list()).toEqual([])
  })

  it('does not rewrite the file for an unchanged re-registration', async () => {
    const dir = await tempDir()
    const registry = await createDeviceRegistry({ dir })
    await registry.register({ token: TOKEN, environment: 'development', hostId: 'host-a' })
    const path = join(dir, 'apns-devices.json')
    const before = await readFile(path, 'utf8')
    await registry.register({ token: TOKEN, environment: 'development', hostId: 'host-a' })
    expect(await readFile(path, 'utf8')).toBe(before)
    // A changed environment is a different token namespace, so it must land.
    await registry.register({ token: TOKEN, environment: 'production', hostId: 'host-a' })
    expect(JSON.parse(await readFile(path, 'utf8')).devices[0].environment).toBe('production')
  })
})

/** Minimal req/res doubles: the route only reads url/method and writes a status
 * plus a JSON body, so a real socket buys nothing here. */
const call = async (
  route: ReturnType<typeof createDeviceRoute>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ consumed: boolean; status: number; json: unknown }> => {
  const listeners = new Map<string, ((value?: unknown) => void)[]>()
  const req = {
    method,
    url,
    headers: {},
    on(event: string, handler: (value?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return req
    },
    destroy() {},
  } as never
  let status = 0
  let payload = ''
  const res = {
    writeHead(code: number) {
      status = code
      return res
    },
    end(chunk?: string) {
      payload = chunk ?? ''
      return res
    },
    once() {
      return res
    },
  } as never

  const pending = route(req, res)
  // Feed the body after the handler has subscribed.
  await Promise.resolve()
  if (body !== undefined) {
    for (const handler of listeners.get('data') ?? []) {
      handler(Buffer.from(JSON.stringify(body)))
    }
  }
  for (const handler of listeners.get('end') ?? []) {
    handler()
  }
  const consumed = await pending
  return { consumed, status, json: payload === '' ? undefined : JSON.parse(payload) }
}

describe('device route', () => {
  const allow = () => ({ via: 'header' })
  const deny = () => null

  it('ignores paths that are not its own, so the dashboard still serves', async () => {
    const registry = await createDeviceRegistry({ dir: null })
    const result = await call(createDeviceRoute(registry, allow), 'POST', '/index.html')
    expect(result.consumed).toBe(false)
  })

  it('refuses an unauthenticated registration', async () => {
    const registry = await createDeviceRegistry({ dir: null })
    const result = await call(createDeviceRoute(registry, deny), 'POST', '/apns/devices', {
      token: TOKEN,
      environment: 'development',
    })
    expect(result.status).toBe(401)
    expect(registry.list()).toEqual([])
  })

  it('registers, then unregisters', async () => {
    const registry = await createDeviceRegistry({ dir: null })
    const route = createDeviceRoute(registry, allow)
    const posted = await call(route, 'POST', '/apns/devices', {
      token: TOKEN,
      environment: 'development',
      hostId: 'host-a',
    })
    expect(posted.status).toBe(200)
    expect(registry.list()).toHaveLength(1)
    const deleted = await call(route, 'DELETE', '/apns/devices', { token: TOKEN })
    expect(deleted.status).toBe(204)
    expect(registry.list()).toEqual([])
  })

  it('rejects a token that is not hex and an unknown environment', async () => {
    const registry = await createDeviceRegistry({ dir: null })
    const route = createDeviceRoute(registry, allow)
    expect((await call(route, 'POST', '/apns/devices', { token: 'nope', environment: 'development' })).status).toBe(400)
    expect((await call(route, 'POST', '/apns/devices', { token: TOKEN, environment: 'staging' })).status).toBe(400)
    expect(registry.list()).toEqual([])
  })
})
