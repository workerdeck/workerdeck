import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliAuth, type CliAuth, type CliPrincipal } from '../src/auth.ts'

const SECRET = 'correct-horse-battery-staple'

// Node lowercases incoming header names; fakes must match or lookups miss.
function fakeReq(init: {
  method?: string
  url?: string
  headers?: Record<string, string>
  remoteAddress?: string
  encrypted?: boolean
}): IncomingMessage {
  return {
    method: init.method ?? 'GET',
    url: init.url ?? '/v1/sessions',
    headers: init.headers ?? {},
    socket: { remoteAddress: init.remoteAddress ?? '127.0.0.1', encrypted: init.encrypted === true },
  } as unknown as IncomingMessage
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve))
  }
})

/** Wire the auth surface the way the CLI's request handler does: auth routes
 * first, then the gateway (authenticate), then the static host (hasValidSession). */
async function startHost(auth: CliAuth): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      if (await auth.handleAuthRequest(req, res)) return
      const pathname = new URL(req.url ?? '/', 'http://internal').pathname
      if (pathname.startsWith('/v1')) {
        const principal = await auth.authenticate(req)
        if (!principal) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ principal }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(auth.hasValidSession(req) ? 'SPA' : 'LOGIN')
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

type RawResponse = { status: number; headers: IncomingMessage['headers']; setCookies: string[]; body: string }

// Raw node:http instead of fetch: the fetch spec marks Origin a forbidden
// request header, and these tests exist to send arbitrary Origins.
function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          setCookies: res.headers['set-cookie'] ?? [],
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

async function login(base: string, secret: string): Promise<{ res: RawResponse; cookie: string }> {
  const res = await request(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret }).toString(),
  })
  return { res, cookie: res.setCookies[0]?.split(';')[0] ?? '' }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('disabled mode (no secret)', () => {
  it('accepts everything and reports the state honestly', async () => {
    const auth = createCliAuth()
    expect(auth.enabled).toBe(false)
    const principal = (await auth.authenticate(fakeReq({ method: 'POST' }))) as CliPrincipal
    expect(principal.via).toBe('open')
    expect(auth.hasValidSession(fakeReq({}))).toBe(true)
  })

  it('refuses login but still serves status', async () => {
    const base = await startHost(createCliAuth())
    const status = await request(`${base}/auth/status`)
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ enabled: false, authenticated: true })
    const res = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'secret=whatever',
    })
    expect(res.status).toBe(409)
  })
})

describe('secret validation', () => {
  it('rejects short and empty secrets at construction', () => {
    expect(() => createCliAuth({ secret: '' })).toThrow(/at least 12/)
    expect(() => createCliAuth({ secret: 'short' })).toThrow(/at least 12/)
  })
})

describe('header transport', () => {
  const auth = createCliAuth({ secret: SECRET })

  it('accepts x-workerdeck-key without any Origin, even on POST', async () => {
    const principal = (await auth.authenticate(
      fakeReq({ method: 'POST', headers: { 'x-workerdeck-key': SECRET, origin: 'https://evil.example' } }),
    )) as CliPrincipal
    // Not ambient authority: the sender chose to attach the secret, so a
    // foreign Origin is irrelevant.
    expect(principal.via).toBe('header')
  })

  it('accepts Authorization: Bearer, scheme case-insensitive', async () => {
    expect(await auth.authenticate(fakeReq({ headers: { authorization: `Bearer ${SECRET}` } }))).toBeTruthy()
    expect(await auth.authenticate(fakeReq({ headers: { authorization: `bearer ${SECRET}` } }))).toBeTruthy()
  })

  it('rejects wrong keys and never falls through to other transports', async () => {
    expect(await auth.authenticate(fakeReq({ headers: { 'x-workerdeck-key': 'wrong' } }))).toBeNull()
    expect(await auth.authenticate(fakeReq({ headers: { authorization: 'Bearer wrong' } }))).toBeNull()
    expect(await auth.authenticate(fakeReq({ headers: { authorization: 'Basic abc' } }))).toBeNull()
    expect(await auth.authenticate(fakeReq({}))).toBeNull()
  })

  it('works on a WS-upgrade-shaped request', async () => {
    const principal = await auth.authenticate(
      fakeReq({ headers: { 'x-workerdeck-key': SECRET, upgrade: 'websocket' } }),
    )
    expect(principal).toBeTruthy()
  })
})

describe('login and cookie flow', () => {
  it('sets a hardened cookie and redirects to /', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const { res } = await login(base, SECRET)
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/')
    const cookie = res.setCookies[0]
    expect(cookie).toMatch(/^workerdeck_session=[A-Za-z0-9_-]+; /)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=604800')
    // Plain HTTP with no trusted proxy: Secure would make the browser drop it.
    expect(cookie).not.toContain('Secure')
  })

  it('authenticates REST GETs by cookie and gates the SPA', async () => {
    const auth = createCliAuth({ secret: SECRET })
    const base = await startHost(auth)
    expect((await request(`${base}/`)).body).toBe('LOGIN')
    const { cookie } = await login(base, SECRET)
    const api = await request(`${base}/v1/sessions`, { headers: { cookie } })
    expect(api.status).toBe(200)
    expect((JSON.parse(api.body) as { principal: CliPrincipal }).principal.via).toBe('cookie')
    expect((await request(`${base}/`, { headers: { cookie } })).body).toBe('SPA')
    const status = await request(`${base}/auth/status`, { headers: { cookie } })
    expect(JSON.parse(status.body)).toEqual({ enabled: true, authenticated: true })
  })

  it('redirects a wrong secret back to the login page without a cookie', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const { res } = await login(base, 'wrong-secret-value')
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/?auth=failed')
    expect(res.setCookies).toEqual([])
  })

  it('speaks JSON when asked to', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const ok = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    })
    expect(ok.status).toBe(204)
    expect(ok.setCookies).toHaveLength(1)
    const bad = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ secret: 'nope-nope-nope' }),
    })
    expect(bad.status).toBe(401)
  })

  it('rejects garbage cookies, unknown content types, and missing fields', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const forged = await request(`${base}/v1/sessions`, {
      headers: { cookie: 'workerdeck_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    })
    expect(forged.status).toBe(401)
    const wrongType = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: SECRET,
    })
    expect(wrongType.status).toBe(415)
    const missing = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=oops',
    })
    expect(missing.status).toBe(400)
  })

  it('405s wrong methods on the auth routes and 404s unknown subpaths', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    expect((await request(`${base}/auth/login`)).status).toBe(405)
    expect((await request(`${base}/auth/status`, { method: 'POST' })).status).toBe(405)
    // Claimed by the auth surface, not the SPA catch-all.
    expect((await request(`${base}/auth/nope`)).status).toBe(404)
  })
})

describe('CSRF: the Origin policy', () => {
  async function cookieAuth(): Promise<{ auth: CliAuth; cookie: string; host: string }> {
    const auth = createCliAuth({ secret: SECRET })
    const base = await startHost(auth)
    const { cookie } = await login(base, SECRET)
    return { auth, cookie, host: new URL(base).host }
  }

  it('requires a matching Origin on cookie-authenticated writes', async () => {
    const { auth, cookie, host } = await cookieAuth()
    const ok = await auth.authenticate(
      fakeReq({ method: 'POST', headers: { cookie, host, origin: `http://${host}` } }),
    )
    expect(ok).toBeTruthy()
    expect(
      await auth.authenticate(
        fakeReq({ method: 'POST', headers: { cookie, host, origin: 'http://evil.example' } }),
      ),
    ).toBeNull()
    // Browsers always send Origin on POST; absence means a non-browser client
    // replaying the cookie, which should use the header transport instead.
    expect(await auth.authenticate(fakeReq({ method: 'POST', headers: { cookie, host } }))).toBeNull()
  })

  it('requires a matching Origin on the WS upgrade — the CORS-exempt path', async () => {
    const { auth, cookie, host } = await cookieAuth()
    const upgrade = { cookie, host, upgrade: 'websocket' }
    expect(
      await auth.authenticate(fakeReq({ headers: { ...upgrade, origin: `http://${host}` } })),
    ).toBeTruthy()
    expect(
      await auth.authenticate(fakeReq({ headers: { ...upgrade, origin: 'http://evil.example' } })),
    ).toBeNull()
    expect(await auth.authenticate(fakeReq({ headers: upgrade }))).toBeNull()
  })

  it('allows plain GETs without Origin but never with a foreign one', async () => {
    const { auth, cookie, host } = await cookieAuth()
    expect(await auth.authenticate(fakeReq({ headers: { cookie, host } }))).toBeTruthy()
    expect(
      await auth.authenticate(fakeReq({ headers: { cookie, host, origin: 'http://evil.example' } })),
    ).toBeNull()
    // 'Origin: null' (sandboxed iframe, data: URL) is foreign, not absent.
    expect(await auth.authenticate(fakeReq({ headers: { cookie, host, origin: 'null' } }))).toBeNull()
  })

  it('treats same host on a different port or scheme as foreign', async () => {
    const { auth, cookie, host } = await cookieAuth()
    // Same-site for SameSite purposes — which is exactly why Lax alone fails.
    expect(
      await auth.authenticate(
        fakeReq({ method: 'POST', headers: { cookie, host, origin: `http://${host.split(':')[0]}:9999` } }),
      ),
    ).toBeNull()
    expect(
      await auth.authenticate(fakeReq({ method: 'POST', headers: { cookie, host, origin: `https://${host}` } })),
    ).toBeNull()
  })

  it('honors allowedOrigins, normalized', async () => {
    const auth = createCliAuth({ secret: SECRET, allowedOrigins: ['https://Ops.Example.com:443/'] })
    const base = await startHost(auth)
    const { cookie } = await login(base, SECRET)
    const principal = await auth.authenticate(
      fakeReq({ method: 'POST', headers: { cookie, host: 'internal:8787', origin: 'https://ops.example.com' } }),
    )
    expect(principal).toBeTruthy()
  })

  it('rejects a foreign-Origin login before it can touch the throttle', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET, throttle: { maxFailuresPerIp: 1 } }))
    const forged = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
      body: 'secret=guess',
    })
    expect(forged.status).toBe(403)
    // The forged post did not count: one real failure is still available...
    const failed = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'secret=wrong-wrong-wrong',
    })
    expect(failed.status).toBe(401)
    // ...and only now is the budget spent.
    const blocked = await request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: `secret=${SECRET}`,
    })
    expect(blocked.status).toBe(429)
  })
})

describe('proxy trust', () => {
  it('only marks the cookie Secure when the operator opted into the proxy header', async () => {
    const insecure = createCliAuth({ secret: SECRET })
    const trusted = createCliAuth({ secret: SECRET, trustProxy: true })
    const insecureBase = await startHost(insecure)
    const trustedBase = await startHost(trusted)
    const spoofed = await request(`${insecureBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
      body: `secret=${SECRET}`,
    })
    expect(spoofed.setCookies[0]).not.toContain('Secure')
    const proxied = await request(`${trustedBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
      body: `secret=${SECRET}`,
    })
    expect(proxied.setCookies[0]).toContain('Secure')
  })

  it('computes the expected origin from forwarded proto/host only under trustProxy', async () => {
    const makeReq = (cookie: string) =>
      fakeReq({
        method: 'POST',
        headers: {
          cookie,
          host: 'internal:8787',
          origin: 'https://worker.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'worker.example.com',
        },
      })
    const trusted = createCliAuth({ secret: SECRET, trustProxy: true })
    const trustedBase = await startHost(trusted)
    const trustedCookie = (await login(trustedBase, SECRET)).cookie
    expect(await trusted.authenticate(makeReq(trustedCookie))).toBeTruthy()
    // Without the opt-in the forwarded headers are attacker input: the check
    // falls back to the socket's view (http://internal:8787) and refuses.
    const bare = createCliAuth({ secret: SECRET })
    const bareBase = await startHost(bare)
    const bareCookie = (await login(bareBase, SECRET)).cookie
    expect(await bare.authenticate(makeReq(bareCookie))).toBeNull()
  })

  it('keys the throttle on the last x-forwarded-for hop — the proxy-written one', async () => {
    const base = await startHost(
      createCliAuth({ secret: SECRET, trustProxy: true, throttle: { maxFailuresPerIp: 1 } }),
    )
    const attempt = (xff: string) =>
      request(`${base}/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'x-forwarded-for': xff,
        },
        body: 'secret=wrong-wrong-wrong',
      })
    expect((await attempt('spoofed, 10.0.0.1')).status).toBe(401)
    expect((await attempt('other-spoof, 10.0.0.1')).status).toBe(429)
    // A different real client is not caught in 10.0.0.1's lockout.
    expect((await attempt('spoofed, 10.0.0.2')).status).toBe(401)
  })
})

describe('throttling', () => {
  const jsonAttempt = (base: string, secret: string) =>
    request(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ secret }).toString(),
    })

  it('locks an IP out after repeated failures — even for the right secret — until the window passes', async () => {
    const base = await startHost(
      createCliAuth({ secret: SECRET, throttle: { windowMs: 200, maxFailuresPerIp: 2 } }),
    )
    expect((await jsonAttempt(base, 'wrong-one-111')).status).toBe(401)
    expect((await jsonAttempt(base, 'wrong-two-222')).status).toBe(401)
    const blocked = await jsonAttempt(base, SECRET)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    await sleep(250)
    expect((await jsonAttempt(base, SECRET)).status).toBe(204)
  })

  it('enforces the global cap across IPs', async () => {
    const base = await startHost(
      createCliAuth({
        secret: SECRET,
        trustProxy: true,
        throttle: { windowMs: 60_000, maxFailuresPerIp: 100, maxFailuresGlobal: 2 },
      }),
    )
    const attempt = (ip: string) =>
      request(`${base}/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'x-forwarded-for': ip,
        },
        body: 'secret=wrong-wrong-wrong',
      })
    expect((await attempt('10.0.0.1')).status).toBe(401)
    expect((await attempt('10.0.0.2')).status).toBe(401)
    // Rotating to a fresh IP buys nothing.
    expect((await attempt('10.0.0.3')).status).toBe(429)
  })

  it('redirect-mode throttling points back at the login page', async () => {
    const base = await startHost(
      createCliAuth({ secret: SECRET, throttle: { windowMs: 60_000, maxFailuresPerIp: 1 } }),
    )
    await login(base, 'wrong-wrong-wrong')
    const blocked = await login(base, SECRET)
    expect(blocked.res.status).toBe(303)
    expect(blocked.res.headers.location).toBe('/?auth=throttled')
  })
})

describe('login page model', () => {
  it('names the endpoint and field, and maps redirect reasons to messages', () => {
    const auth = createCliAuth({ secret: SECRET })
    expect(auth.loginPage(fakeReq({ url: '/' }))).toEqual({
      action: '/auth/login',
      field: 'secret',
      error: undefined,
    })
    expect(auth.loginPage(fakeReq({ url: '/?auth=failed' })).error).toMatch(/invalid/i)
    expect(auth.loginPage(fakeReq({ url: '/?auth=throttled' })).error).toMatch(/too many/i)
    expect(auth.loginPage(fakeReq({ url: '/?auth=unknown' })).error).toBeUndefined()
  })
})

describe('expiry, logout, restart', () => {
  it('expires sessions after ttlMs', async () => {
    const auth = createCliAuth({ secret: SECRET, ttlMs: 60 })
    const base = await startHost(auth)
    const { cookie } = await login(base, SECRET)
    expect((await request(`${base}/v1/sessions`, { headers: { cookie } })).status).toBe(200)
    await sleep(100)
    expect((await request(`${base}/v1/sessions`, { headers: { cookie } })).status).toBe(401)
    expect((await request(`${base}/`, { headers: { cookie } })).body).toBe('LOGIN')
  })

  it('logout invalidates the server-side session, not just the cookie', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const { cookie } = await login(base, SECRET)
    const out = await request(`${base}/auth/logout`, { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(303)
    expect(out.setCookies[0]).toContain('Max-Age=0')
    // The old token is dead even if a stale copy is replayed.
    expect((await request(`${base}/v1/sessions`, { headers: { cookie } })).status).toBe(401)
  })

  it('logout without a session is a harmless no-op', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const out = await request(`${base}/auth/logout`, { method: 'POST', headers: { accept: 'application/json' } })
    expect(out.status).toBe(204)
  })

  it('a restart signs every browser out — sessions are in-memory by design', async () => {
    const base = await startHost(createCliAuth({ secret: SECRET }))
    const { cookie } = await login(base, SECRET)
    const restarted = createCliAuth({ secret: SECRET })
    expect(await restarted.authenticate(fakeReq({ headers: { cookie } }))).toBeNull()
    expect(restarted.hasValidSession(fakeReq({ headers: { cookie } }))).toBe(false)
  })
})
