import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerFrame } from '@workerdeck/protocol'
import { parseArgs, resolveInstanceConfig, type ResolvedConfig } from '../src/config.ts'
import { startInstance, type Instance } from '../src/lib/instance.ts'

/**
 * The end-to-end check the whole single-port design exists for: a browser with
 * nothing but a cookie must be able to load the dashboard, call the API, **and
 * attach a live session over WebSocket**. A REST-only test passes right through
 * the regression that matters, because the upgrade is the one request a tab
 * cannot put a header on.
 *
 * No tokens are spent: `buildRunnerConfig` injects a fake `queryFn`, the same
 * trick the server package's integration tests use.
 */

const SECRET = 'a-long-enough-test-secret'

/** Minimal stand-in for the Agent SDK's `query()`. */
function fakeQueryFn() {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const emit = (msg: SDKMessage): void => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else {
      messages.push(msg)
    }
  }
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const buffered = messages.shift()
      if (buffered !== undefined) {
        return Promise.resolve({ value: buffered, done: false })
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    close: () => {
      done = true
    },
  } as unknown as Query

  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    void (async () => {
      for await (const _ of params.prompt as AsyncIterable<SDKUserMessage>) {
        // drain the streaming input so the runner isn't backpressured
      }
    })()
    return query
  }
  return { queryFn, emit }
}

let instance: Instance | undefined
const dirs: string[] = []

afterEach(async () => {
  await instance?.close()
  instance = undefined
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A dashboard build stand-in — the real one is only present after a prepack. */
async function fakeWebRoot(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-web-'))
  dirs.push(dir)
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>dashboard</title>')
  await writeFile(join(dir, 'assets', 'app-abc123.js'), 'export const x = 1\n')
  return dir
}

/** `overrides` lands after resolution, so a test can resolve routable-host
 * semantics (generated keys, insecure hosts) while still binding loopback. */
async function start(
  argv: string[],
  overrides: Partial<ResolvedConfig> = {},
): Promise<{ base: string; wsBase: string; stateDir: string | null }> {
  const webRoot = await fakeWebRoot()
  const stateDir = await mkdtemp(join(import.meta.dirname, '.tmp-state-'))
  dirs.push(stateDir)
  const config: ResolvedConfig = {
    ...resolveInstanceConfig(parseArgs(['--port', '0', ...argv]), { path: null, options: {} }, {}),
    webRoot,
    stateDir,
    ...overrides,
  }
  config.options.profiles = []
  config.options.allowedCwdRoots = ['/tmp']
  config.options.buildRunnerConfig = (req) => ({ ...req, queryFn: fakeQueryFn().queryFn })
  instance = await startInstance(config, { quiet: true })
  return {
    base: `http://127.0.0.1:${instance.port}`,
    wsBase: `ws://127.0.0.1:${instance.port}`,
    stateDir: config.stateDir,
  }
}

/** A GET with a Host header of our choosing — see the rebinding test. */
function rawGet(port: number, path: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Extract our session cookie from a Set-Cookie header. */
const cookieFrom = (res: Response): string => {
  const raw = res.headers.get('set-cookie')
  expect(raw).toBeTruthy()
  return raw!.split(';')[0]!
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ secret: SECRET }),
    redirect: 'manual',
  })
  expect(res.status).toBe(303)
  return cookieFrom(res)
}

describe('an unauthenticated instance', () => {
  it('serves the dashboard and the API from one port', async () => {
    const { base } = await start([])

    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(await page.text()).toContain('dashboard')
    // index.html must revalidate or a deployed update never reaches a browser.
    expect(page.headers.get('cache-control')).toMatch(/no-cache/)

    const asset = await fetch(`${base}/assets/app-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const api = await fetch(`${base}/v1/sessions`)
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ sessions: [] })
  })

  it('serves index.html for an app route, since hash history never reaches us', async () => {
    const { base } = await start([])
    const res = await fetch(`${base}/some/deep/route`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('dashboard')
  })

  it('404s a missing asset instead of handing back the SPA shell', async () => {
    const { base } = await start([])
    expect((await fetch(`${base}/assets/nope-000.js`)).status).toBe(404)
  })

  it('refuses a rebound Host on both the API and the dashboard', async () => {
    await start([])
    const port = instance!.port
    // Raw http, not fetch: `Host` is a forbidden header name in fetch, so undici
    // drops it silently and the request would be indistinguishable from a normal
    // one — the test would pass while testing nothing.
    expect((await rawGet(port, '/', 'attacker.example')).status).toBe(403)
    expect((await rawGet(port, '/v1/sessions', 'attacker.example')).status).toBe(401)
    // …and the same requests with a loopback Host are fine.
    expect((await rawGet(port, '/', `127.0.0.1:${port}`)).status).toBe(200)
    expect((await rawGet(port, '/v1/sessions', `localhost:${port}`)).status).toBe(200)
  })
})

describe('an instance with --auth-key', () => {
  it('shows the login page instead of the dashboard, and refuses the API', async () => {
    const { base } = await start(['--auth-key', SECRET])

    const page = await fetch(`${base}/`)
    expect(page.status).toBe(401)
    const html = await page.text()
    expect(html).toContain('Access key')
    expect(html).toContain('action="/auth/login"')
    expect(html).not.toContain('dashboard')

    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401)
  })

  it('accepts the secret as a header for services', async () => {
    const { base } = await start(['--auth-key', SECRET])
    const res = await fetch(`${base}/v1/sessions`, { headers: { 'x-workerdeck-key': SECRET } })
    expect(res.status).toBe(200)
  })

  it('logs a browser in and then serves the dashboard', async () => {
    const { base } = await start(['--auth-key', SECRET])
    const cookie = await login(base)

    const page = await fetch(`${base}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('dashboard')

    const api = await fetch(`${base}/v1/sessions`, { headers: { cookie } })
    expect(api.status).toBe(200)
  })

  it('re-renders the login page with an error after a wrong secret', async () => {
    const { base } = await start(['--auth-key', SECRET])
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ secret: 'wrong-but-long-enough' }),
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/?auth=failed')
    expect(await (await fetch(`${base}/?auth=failed`)).text()).toContain('Invalid access key')
  })

  it('invalidates the cookie on logout', async () => {
    const { base } = await start(['--auth-key', SECRET])
    const cookie = await login(base)
    expect((await fetch(`${base}/v1/sessions`, { headers: { cookie } })).status).toBe(200)

    await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: base },
      redirect: 'manual',
    })
    // The server-side entry is gone, so a stolen copy of the cookie is dead too.
    expect((await fetch(`${base}/v1/sessions`, { headers: { cookie } })).status).toBe(401)
  })
})

describe('an instance that generates its own key', () => {
  // Resolved as if bound to 0.0.0.0 (which is what plans the generated key),
  // then actually bound to loopback so the test never opens a routable port.
  const routable = ['--host', '0.0.0.0']
  const bindLoopback = { host: '127.0.0.1' }

  it('materializes a key into the state dir and requires it', async () => {
    const { base, stateDir } = await start(routable, bindLoopback)
    const key = (await readFile(join(stateDir!, 'auth-key'), 'utf8')).trim()
    expect(key).toMatch(/^[0-9a-f]{48}$/)

    // No credential: login page, not dashboard; API refused.
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401)
    // The stored key is the live secret on both transports.
    expect((await fetch(`${base}/v1/sessions`, { headers: { 'x-workerdeck-key': key } })).status).toBe(200)
  })

  it('reuses the stored key across restarts — clients stay paired', async () => {
    const first = await start(routable, bindLoopback)
    const key = (await readFile(join(first.stateDir!, 'auth-key'), 'utf8')).trim()
    await instance!.close()
    instance = undefined

    const second = await start(routable, { ...bindLoopback, stateDir: first.stateDir })
    const res = await fetch(`${second.base}/v1/sessions`, {
      headers: { 'x-workerdeck-key': key },
    })
    expect(res.status).toBe(200)
  })

  it('still authenticates with an ephemeral key when parking is off', async () => {
    const { base } = await start(routable, { ...bindLoopback, stateDir: null })
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401)
  })

  it('refuses to serve when resolve promised auth but nothing materialized a secret', async () => {
    // The catastrophic seam bug, asserted where it cannot be skipped: the
    // Host-header guard stood down (allowedHosts null) yet no key will exist.
    const webRoot = await fakeWebRoot()
    const config: ResolvedConfig = {
      ...resolveInstanceConfig(parseArgs(['--port', '0']), { path: null, options: {} }, {}),
      webRoot,
      stateDir: null,
      allowedHosts: null,
      generateAuthKey: false,
    }
    await expect(startInstance(config, { quiet: true })).rejects.toThrow(/no shared secret/)
  })
})

describe('an instance with insecure hosts', () => {
  it('serves unauthenticated on the declared name, Host gate still fenced', async () => {
    await start(['--host', '0.0.0.0', '--insecure-host', '0.0.0.0', '--insecure-host', 'devbox'], {
      host: '127.0.0.1',
    })
    const port = instance!.port
    // The declared name works with no key anywhere…
    expect((await rawGet(port, '/', `devbox:${port}`)).status).toBe(200)
    expect((await rawGet(port, '/v1/sessions', `devbox:${port}`)).status).toBe(200)
    // …loopback still does…
    expect((await rawGet(port, '/', `127.0.0.1:${port}`)).status).toBe(200)
    // …and a rebound public name still bounces.
    expect((await rawGet(port, '/', 'attacker.example')).status).toBe(403)
    expect((await rawGet(port, '/v1/sessions', 'attacker.example')).status).toBe(401)
  })
})

describe('attaching a live session', () => {
  /** The regression a REST-only check cannot see. */
  const attach = async (wsBase: string, sessionId: string, headers: Record<string, string>) => {
    const ws = new WebSocket(`${wsBase}/v1/sessions/${sessionId}/ws?afterSeq=0`, { headers })
    return await new Promise<{ ok: boolean; frame?: ServerFrame }>((resolve) => {
      const fail = () => resolve({ ok: false })
      ws.on('error', fail)
      ws.on('unexpected-response', fail)
      ws.on('message', (data) => {
        ws.close()
        resolve({ ok: true, frame: JSON.parse(String(data)) as ServerFrame })
      })
    })
  }

  const createSession = async (base: string, headers: Record<string, string>): Promise<string> => {
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      // `origin` because a browser sets it on every non-GET fetch, same-origin
      // included — which is exactly what the cookie transport requires.
      headers: { 'content-type': 'application/json', origin: base, ...headers },
      body: JSON.stringify({ cwd: '/tmp', prompt: 'hello' }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { session: { id: string } }).session.id
  }

  it('attaches with nothing but the login cookie', async () => {
    const { base, wsBase } = await start(['--auth-key', SECRET])
    const cookie = await login(base)
    const id = await createSession(base, { cookie })

    // Origin is what a browser sends on the handshake; the cookie rides along
    // by itself. No header carries the secret here — that is the whole point.
    const result = await attach(wsBase, id, { cookie, origin: base })
    expect(result.ok).toBe(true)
    expect(result.frame?.type).toBe('attached')
  })

  it('refuses an upgrade carrying the cookie from a foreign origin', async () => {
    const { base, wsBase } = await start(['--auth-key', SECRET])
    const cookie = await login(base)
    const id = await createSession(base, { cookie })

    // WebSocket is exempt from CORS, so without this check a hostile page could
    // read the whole session stream using the victim's ambient cookie.
    const result = await attach(wsBase, id, { cookie, origin: 'http://evil.example' })
    expect(result.ok).toBe(false)
  })

  it('refuses an upgrade with no credential at all', async () => {
    const { base, wsBase } = await start(['--auth-key', SECRET])
    const cookie = await login(base)
    const id = await createSession(base, { cookie })
    expect((await attach(wsBase, id, {})).ok).toBe(false)
  })

  it('attaches on an unauthenticated instance', async () => {
    const { base, wsBase } = await start([])
    const id = await createSession(base, {})
    const result = await attach(wsBase, id, { origin: base })
    expect(result.ok).toBe(true)
    expect(result.frame?.type).toBe('attached')
  })
})

/**
 * The forwarder's own route, mounted through the same `fallback` hook that
 * serves the dashboard. Nothing here talks to Apple — what is being checked is
 * the wiring: that the route is reachable at all, that it sits *ahead* of the
 * SPA catch-all (which would otherwise answer a failed registration with a 200
 * and an HTML document), and that it is behind the same key as everything else.
 */
describe('apns device route', () => {
  /** A stand-in for the .p8: the same EC key an Apple auth key is, minted here
   * so the test needs no credential. */
  async function fakeKeyFile(): Promise<string> {
    const dir = await mkdtemp(join(import.meta.dirname, '.tmp-p8-'))
    dirs.push(dir)
    const path = join(dir, 'AuthKey_TEST123456.p8')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    return path
  }

  const apnsConfig = async () => ({
    keyFile: await fakeKeyFile(),
    keyId: 'TEST123456',
    teamId: 'TEAM123456',
    topic: 'bi.atomic.workerdeck.ios',
  })

  const register = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/apns/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const TOKEN = 'b'.repeat(64)

  it('registers a device with the same key the app already holds', async () => {
    const { base, stateDir } = await start(['--auth-key', SECRET], { apns: await apnsConfig() })
    const res = await register(base, { token: TOKEN, environment: 'development', hostId: 'host-a' }, { authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(200)
    // The environment is echoed because it is the one fact that is expensive to
    // get wrong and invisible from the client otherwise.
    expect(await res.json()).toEqual({ registered: true, environment: 'development' })
    const stored = JSON.parse(await readFile(join(stateDir!, 'apns-devices.json'), 'utf8'))
    expect(stored.devices[0].token).toBe(TOKEN)
  })

  it('refuses registration without the key, rather than falling through to the SPA', async () => {
    const { base } = await start(['--auth-key', SECRET], { apns: await apnsConfig() })
    const res = await register(base, { token: TOKEN, environment: 'development' })
    expect(res.status).toBe(401)
  })

  it('404s when the instance has no forwarder — how the app learns not to ask', async () => {
    const { base } = await start(['--auth-key', SECRET])
    const res = await register(base, { token: TOKEN, environment: 'development' }, { authorization: `Bearer ${SECRET}` })
    // Exactly 404, not merely "not 200". The app reads 404 as `unsupported` and
    // stops asking; anything else it treats as a broken gateway, so it throws,
    // never marks the host synced, and retries on every foreground. This
    // assertion used to be `not.toBe(200)`, which the 405 the SPA catch-all
    // actually returned passed happily — the bug was in the gap between this
    // test's name and what it checked.
    expect(res.status).toBe(404)
  })

  it('404s the same way with the dashboard off, and never serves a document there', async () => {
    const { base } = await start(['--auth-key', SECRET, '--no-web'])
    const res = await register(base, { token: TOKEN, environment: 'development' }, { authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
  })
})
