import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Authenticator } from '@workerdeck/server'

/**
 * Gateway auth for the turnkey CLI: one shared operator secret, three transports.
 *
 * Services present the secret itself on every request (`x-workerdeck-key`,
 * or `Authorization: Bearer`). The dashboard *served by this gateway* cannot:
 * it calls `location.origin + '/v1'` with no headers, and a browser WebSocket
 * handshake carries no custom headers at all. So browsers POST the secret once
 * to `/auth/login`, get an HttpOnly cookie naming a server-side session, and
 * the cookie rides same-origin REST and the WS upgrade automatically. That
 * automatic ride is also the threat: the cookie is ambient authority, and the
 * WS handshake is exempt from CORS, so cross-origin misuse is fenced off by an
 * explicit Origin check here — not by the browser.
 *
 * The third transport exists for a dashboard served *elsewhere* attaching to
 * this gateway: it holds the key (the operator typed it in) and can put it on
 * REST as a header, but still cannot put it on the WS handshake — and the
 * cookie is another origin's, so it does not ride either. Such a client passes
 * the key as `?key=` on the upgrade URL, and `querySecret` below accepts it
 * **on upgrades only**.
 *
 * That is a deliberate, narrow concession, and its cost should be understood
 * rather than rediscovered: a key in a query string is a permanent, replayable
 * credential sitting in reverse-proxy access logs, where a header would not be.
 * It is confined to upgrades so a leaked URL buys an attach and nothing else,
 * and the seam it arrives through (`ClientOptions.buildWsUrl`) is the same one
 * a short-lived minted ticket would use — swapping to one later needs no client
 * change.
 *
 * This file guards the operator's own gateway and nothing else. It never sees
 * an Anthropic credential — those are resolved by the SDK/CLI from the
 * operator's environment (root CLAUDE.md, auth red lines).
 */

export type CliAuthOptions = {
  /**
   * The shared operator secret. Unset disables auth entirely (the CLI then
   * refuses to bind anything but loopback — enforced by the caller, not here).
   * An empty or short value is a config accident, not a choice: anything under
   * 12 characters throws rather than standing up a guessable gateway.
   */
  secret?: string
  /** Default 'workerdeck_session'. No `__Host-` prefix — it requires
   * `Secure`, and plain-HTTP localhost is the primary deployment. */
  cookieName?: string
  /**
   * Browser session lifetime, default 7 days. Fixed, not sliding: the auth
   * hooks only see the request, so a renewed cookie has nowhere to ride — and
   * for a dashboard whose whole login is retyping one secret, a periodic
   * re-login is cheaper than a refresh endpoint. Expiry simply lands the
   * operator back on the login page — as does a restart, unless a `sessions`
   * store is supplied (the CLI supplies one whenever it has a state dir).
   */
  ttlMs?: number
  /**
   * Trust `x-forwarded-proto` / `x-forwarded-host` / `x-forwarded-for` from
   * exactly one reverse proxy in front of this process; the *last* value of
   * each is used (the one the proxy set, the only position a client cannot
   * forge). Off by default: these are attacker-writable headers on a directly
   * exposed port. Behind a TLS-terminating proxy this must be on, or the
   * `Secure` cookie flag is skipped and the Origin check computes `http://`
   * where the browser says `https://` and rejects the dashboard's own writes.
   */
  trustProxy?: boolean
  /**
   * Origins accepted in addition to the request's own (scheme + Host). Needed
   * when the proxy rewrites Host so the external origin no longer matches what
   * this process sees. Entries must be full origins ('https://ops.example.com');
   * invalid ones throw at startup rather than silently never matching.
   */
  allowedOrigins?: string[]
  /** Login throttle tuning; defaults: 15 min window, 10 failures per IP, 100
   * globally. Exposed mainly so tests need not wait out real windows. */
  throttle?: { windowMs?: number; maxFailuresPerIp?: number; maxFailuresGlobal?: number }
  /**
   * Makes browser logins survive a restart. Absent, the session table is
   * in-memory and a restart signs every browser out — see the table's own note.
   * `createAuthSessionStore` is the CLI's file-backed implementation.
   */
  sessions?: CliSessionStore
}

/** One session-table row as it is handed to a store; the key is opaque here. */
export type StoredSession = { expiresAt: number }

/**
 * The durability seam for browser logins. Deliberately narrow and
 * fire-and-forget: the auth paths are synchronous, so a store may not make them
 * wait, and a store that cannot write must degrade to "logins do not survive a
 * restart" rather than refuse a login.
 */
export type CliSessionStore = {
  /** Rows recovered at startup, already pruned of expired ones. */
  initial?: Iterable<[string, StoredSession]>
  /** The whole live table after a mutation. Must not throw. */
  save(entries: [string, StoredSession][]): void
  /** Resolves once queued writes have landed — for tests and shutdown. */
  flush?(): Promise<void>
}

/** What `authenticate` hands the worker server as the request principal. */
export type CliPrincipal = {
  /** Which transport authenticated the request; 'open' when auth is disabled. */
  via: 'header' | 'cookie' | 'open'
  /** One secret, one trust level: whoever holds it is the operator, so the
   * dashboard may manage provider profiles (still bounded by the server's
   * `allowedConfigDirRoots`). */
  canManageProfiles: true
}

export type CliAuth = {
  enabled: boolean
  /** Hand straight to `createWorkerServer({ authenticate })` — it guards both
   * REST and the WS upgrade, which is exactly why the Origin policy lives in it. */
  authenticate: Authenticator
  /** Claims `/auth` and everything under it (login/logout/status); returns true
   * when it consumed the request. The static host must call this first. */
  handleAuthRequest(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>
  /** Cookie-only check for the static host: login page or SPA? Gating the SPA
   * shell is UX, not security — every byte of data sits behind `authenticate`. */
  hasValidSession(req: IncomingMessage): boolean
  /** What the login page needs to render for this request. The endpoint path,
   * field name, and the `?auth=` redirect params are all this module's wire
   * format, so the page learns them here instead of hardcoding them. */
  loginPage(req: IncomingMessage): { action: string; field: string; error?: string }
}

const MIN_SECRET_LENGTH = 12
const DEFAULT_COOKIE_NAME = 'workerdeck_session'
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_THROTTLE_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_MAX_FAILURES_PER_IP = 10
const DEFAULT_MAX_FAILURES_GLOBAL = 100
/** Only successful logins insert, so this cap only fences the secret-holder's
 * own memory use (every login within the ttl is a live entry). Oldest goes. */
const MAX_SESSIONS = 100
const MAX_LOGIN_BODY_BYTES = 4096
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

export function createCliAuth(options: CliAuthOptions = {}): CliAuth {
  const { secret } = options
  const enabled = secret !== undefined
  if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `createCliAuth: secret must be at least ${MIN_SECRET_LENGTH} characters — ` +
        'use a long random value, or leave it unset to run without auth on loopback',
    )
  }
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!(ttlMs > 0)) throw new Error('createCliAuth: ttlMs must be positive')
  const trustProxy = options.trustProxy === true
  const windowMs = options.throttle?.windowMs ?? DEFAULT_THROTTLE_WINDOW_MS
  const maxFailuresPerIp = options.throttle?.maxFailuresPerIp ?? DEFAULT_MAX_FAILURES_PER_IP
  const maxFailuresGlobal = options.throttle?.maxFailuresGlobal ?? DEFAULT_MAX_FAILURES_GLOBAL
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? []).map((entry) => {
      try {
        return new URL(entry).origin
      } catch {
        throw new Error(`createCliAuth: allowedOrigins entry is not a valid origin: ${JSON.stringify(entry)}`)
      }
    }),
  )

  /** Both the raw secret and session tokens are compared as fixed-length SHA-256
   * digests via timingSafeEqual / digest-keyed lookup, so no code path compares
   * secret material byte-by-byte with early exit — and unequal input lengths
   * leak nothing either. */
  const secretDigest = secret === undefined ? undefined : sha256(secret)
  const secretMatches = (candidate: string): boolean =>
    secretDigest !== undefined && timingSafeEqual(sha256(candidate), secretDigest)

  /**
   * Browser sessions are a server-side table, not signed tokens: logout must
   * actually invalidate, and a stateless HMAC token stays valid until expiry no
   * matter what the server thinks. This is one long-lived process (multi-node
   * is a non-goal), so "table" means one Map — optionally mirrored to a
   * `CliSessionStore` so a restart does not sign every browser out while the
   * browser still holds a cookie the ttl says is good for a week.
   *
   * Keys are `HMAC-SHA256(secret, token)`, which buys three things at once:
   * recovering a token from a key (or from lookup timing) needs a preimage;
   * what a store writes to disk is not credential material; and rotating the
   * operator secret invalidates every outstanding cookie **for free**, since
   * rows written under the old secret can no longer be looked up and age out on
   * their own expiry.
   */
  const sessions = new Map<string, StoredSession>()
  const store = options.sessions
  const tokenKey = (token: string): string =>
    secret === undefined ? sha256(token).toString('hex') : createHmac('sha256', secret).update(token).digest('hex')

  if (store?.initial !== undefined) {
    for (const [key, entry] of store.initial) {
      if (sessions.size >= MAX_SESSIONS) break
      sessions.set(key, { expiresAt: entry.expiresAt })
    }
  }

  // Every mutation republishes the whole table: it is capped at MAX_SESSIONS,
  // and a diff protocol would be a second source of truth to keep honest.
  const persist = (): void => store?.save([...sessions])

  const createSession = (): string => {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    const token = randomBytes(32).toString('base64url')
    sessions.set(tokenKey(token), { expiresAt: Date.now() + ttlMs })
    persist()
    return token
  }

  const cookieToken = (req: IncomingMessage): string | undefined => {
    const header = req.headers.cookie
    if (typeof header !== 'string') return undefined
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim()
    }
    return undefined
  }

  const hasSession = (req: IncomingMessage): boolean => {
    const token = cookieToken(req)
    if (token === undefined || token === '') return false
    const key = tokenKey(token)
    const entry = sessions.get(key)
    if (entry === undefined) return false
    if (entry.expiresAt <= Date.now()) {
      sessions.delete(key)
      persist()
      return false
    }
    return true
  }

  /** Last value of a possibly comma-joined forwarded header — the one appended
   * (or set) by the trusted proxy; every earlier position is client-writable. */
  const forwardedLast = (value: string | string[] | undefined): string | undefined => {
    if (value === undefined) return undefined
    const joined = Array.isArray(value) ? value.join(',') : value
    const last = joined.split(',').at(-1)?.trim()
    return last === '' ? undefined : last
  }

  const isSecure = (req: IncomingMessage): boolean => {
    if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
    return trustProxy && forwardedLast(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https'
  }

  /** The origin this server believes it is being served as, from the request's
   * own Host (or the proxy's forwarded host) — the only self-knowledge we have. */
  const expectedOrigin = (req: IncomingMessage): string | null => {
    const host = (trustProxy ? forwardedLast(req.headers['x-forwarded-host']) : undefined) ?? req.headers.host
    if (host === undefined || host === '') return null
    try {
      return new URL(`${isSecure(req) ? 'https' : 'http'}://${host}`).origin
    } catch {
      return null
    }
  }

  /**
   * The CSRF core. `SameSite=Lax` alone is not enough for two reasons: same
   * *site* is not same *origin* (another port on localhost — any other local
   * web app — is same-site, cookies attach), and the WS handshake is exempt
   * from CORS, so a foreign page that gets the cookie attached can read the
   * stream. So the Origin header is checked explicitly, against the request's
   * own origin (full scheme + authority: an http:// page on the same host must
   * not drive the https:// dashboard) or the operator's allowlist. `Origin:
   * null` and unparseable values are foreign. Verdicts are tri-state because
   * absence means different things per call site: every current browser sends
   * Origin on cross-site POSTs and every WS handshake, so absence means a
   * non-browser client — which carries no ambient cookie and gets to decide
   * per-endpoint below.
   */
  const originVerdict = (req: IncomingMessage): 'absent' | 'ok' | 'foreign' => {
    const raw = req.headers.origin
    if (raw === undefined) return 'absent'
    let origin: string
    try {
      origin = new URL(raw).origin
    } catch {
      return 'foreign'
    }
    if (allowedOrigins.has(origin)) return 'ok'
    const expected = expectedOrigin(req)
    return expected !== null && origin === expected ? 'ok' : 'foreign'
  }

  const headerSecret = (req: IncomingMessage): string | undefined => {
    const key = req.headers['x-workerdeck-key']
    if (typeof key === 'string' && key !== '') return key
    const authorization = req.headers.authorization
    if (typeof authorization === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authorization)
      if (match !== null) return match[1]
    }
    return undefined
  }

  const openPrincipal: CliPrincipal = { via: 'open', canManageProfiles: true }

  const isUpgradeRequest = (req: IncomingMessage): boolean => {
    const upgrade = req.headers.upgrade
    return typeof upgrade === 'string' && upgrade.toLowerCase().includes('websocket')
  }

  /**
   * The secret from `?key=` — **accepted on WebSocket upgrades only**.
   *
   * A browser cannot put a header on a WS handshake, so a tab attaching to a
   * gateway that is not its own origin (where the cookie would ride) has no
   * other way to present the key. That is the whole reason this exists.
   *
   * Restricting it to upgrades is what keeps the blast radius at "one attach":
   * a key in a query string is not a transport we want anywhere else, because
   * URLs land in proxy access logs and browser history in a way headers do not.
   * A REST call with `?key=` is therefore *not* authenticated by it.
   */
  const querySecret = (req: IncomingMessage): string | undefined => {
    if (!isUpgradeRequest(req)) return undefined
    const key = new URL(req.url ?? '/', 'http://internal').searchParams.get('key')
    return key !== null && key !== '' ? key : undefined
  }

  const authenticate: Authenticator = (req) => {
    if (!enabled) return openPrincipal
    // Header first: the secret itself is not ambient — the sender chose to
    // attach it — so no Origin check applies. A present-but-wrong header is a
    // rejection, never a fall-through to the cookie.
    const provided = headerSecret(req) ?? querySecret(req)
    if (provided !== undefined) {
      return secretMatches(provided) ? ({ via: 'header', canManageProfiles: true } satisfies CliPrincipal) : null
    }
    if (!hasSession(req)) return null
    const verdict = originVerdict(req)
    // A cookie-authenticated request must never carry a foreign Origin, no
    // matter the method — there is no legitimate cross-origin use of this API
    // from a browser (no CORS headers are ever served).
    if (verdict === 'foreign') return null
    // State-changing methods and WS upgrades additionally require Origin to be
    // present: browsers always send it there, so absence means a non-browser
    // client replaying the cookie — which should be using the header transport.
    const isUpgrade = isUpgradeRequest(req)
    const unsafe = !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())
    if ((isUpgrade || unsafe) && verdict !== 'ok') return null
    return { via: 'cookie', canManageProfiles: true } satisfies CliPrincipal
  }

  /**
   * Login throttle: the secret is the only factor and the endpoint is reachable
   * by anyone who can reach the port, so guessing must be rate-limited. Failed
   * attempts count per client IP inside a fixed window, with a global cap
   * behind it so rotating IPs (trivial over IPv6) buys an attacker nothing.
   * Only wrong secrets count — malformed requests and foreign-Origin posts are
   * refused earlier precisely so a hostile page cannot burn a victim IP's
   * budget cross-site. The global cap also bounds this map's size: expired
   * entries are swept once it grows past a nominal size.
   */
  const failures = new Map<string, { count: number; windowStart: number }>()
  const globalFailures = { count: 0, windowStart: 0 }

  const clientIp = (req: IncomingMessage): string =>
    (trustProxy ? forwardedLast(req.headers['x-forwarded-for']) : undefined) ??
    req.socket.remoteAddress ??
    'unknown'

  const blockedMs = (entry: { count: number; windowStart: number } | undefined, max: number, now: number): number =>
    entry !== undefined && entry.count >= max && now - entry.windowStart < windowMs
      ? entry.windowStart + windowMs - now
      : 0

  const loginBlockedMs = (ip: string, now: number): number =>
    Math.max(blockedMs(failures.get(ip), maxFailuresPerIp, now), blockedMs(globalFailures, maxFailuresGlobal, now))

  const recordFailure = (ip: string, now: number): void => {
    if (failures.size > 256) {
      for (const [key, entry] of failures) {
        if (now - entry.windowStart >= windowMs) failures.delete(key)
      }
    }
    const entry = failures.get(ip)
    if (entry === undefined || now - entry.windowStart >= windowMs) {
      failures.set(ip, { count: 1, windowStart: now })
    } else {
      entry.count += 1
    }
    if (now - globalFailures.windowStart >= windowMs) {
      globalFailures.count = 1
      globalFailures.windowStart = now
    } else {
      globalFailures.count += 1
    }
  }

  const cookieAttributes = (req: IncomingMessage): string[] => {
    // Lax over Strict deliberately: Strict drops the cookie on top-level
    // navigation from an external link, landing a logged-in operator on the
    // login page; the delta Strict would buy (cookie-bearing cross-site GET
    // navigations) changes no state and is unreadable cross-origin anyway. The
    // real CSRF surfaces — same-site-different-port and the WS handshake —
    // need the Origin check regardless of SameSite value.
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax']
    if (isSecure(req)) attrs.push('Secure')
    return attrs
  }

  const setCookieValue = (token: string, req: IncomingMessage): string =>
    [`${cookieName}=${token}`, `Max-Age=${Math.ceil(ttlMs / 1000)}`, ...cookieAttributes(req)].join('; ')

  const clearCookieValue = (req: IncomingMessage): string =>
    [`${cookieName}=`, 'Max-Age=0', ...cookieAttributes(req)].join('; ')

  const respondJson = (
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): void => {
    res
      .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      .end(JSON.stringify(body))
  }

  const respondRedirect = (res: ServerResponse, location: string, headers?: Record<string, string>): void => {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...headers }).end()
  }

  /** JSON responses when the client asks for them, 303 redirects otherwise —
   * so a dependency-free `<form method="post">` login page works without JS,
   * and a fetch()-based one gets real status codes. */
  const wantsJson = (req: IncomingMessage): boolean => (req.headers.accept ?? '').includes('application/json')

  const readBody = (req: IncomingMessage, maxBytes: number): Promise<string | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const finish = (value: string | null): void => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          finish(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => finish(null))
    })

  const handleLogin = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = wantsJson(req)
    if (!enabled) {
      respondJson(res, 409, { error: 'auth is disabled: no secret is configured' })
      return
    }
    // Foreign-Origin posts are refused before touching the throttle — see the
    // throttle note. Absent Origin is allowed here (curl-style provisioning):
    // a browser-borne forgery always carries Origin, so absence proves this is
    // not a victim's browser being driven cross-site.
    if (originVerdict(req) === 'foreign') {
      respondJson(res, 403, { error: 'origin not allowed' })
      return
    }
    const ip = clientIp(req)
    const blocked = loginBlockedMs(ip, Date.now())
    if (blocked > 0) {
      const retryAfter = String(Math.ceil(blocked / 1000))
      if (json) respondJson(res, 429, { error: 'too many failed attempts' }, { 'retry-after': retryAfter })
      else respondRedirect(res, '/?auth=throttled', { 'retry-after': retryAfter })
      return
    }
    const body = await readBody(req, MAX_LOGIN_BODY_BYTES)
    if (body === null) {
      respondJson(res, 413, { error: 'body too large' })
      // The socket cannot be reused: the remainder of an oversized request
      // would desync the next keep-alive exchange. Destroy once the response
      // has flushed.
      res.once('finish', () => req.destroy())
      return
    }
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    let candidate: unknown
    if (contentType === 'application/x-www-form-urlencoded') {
      candidate = new URLSearchParams(body).get('secret')
    } else if (contentType === 'application/json') {
      try {
        candidate = (JSON.parse(body) as { secret?: unknown }).secret
      } catch {
        respondJson(res, 400, { error: 'invalid body' })
        return
      }
    } else {
      respondJson(res, 415, { error: 'expected application/x-www-form-urlencoded or application/json' })
      return
    }
    if (typeof candidate !== 'string' || candidate === '') {
      respondJson(res, 400, { error: 'missing secret' })
      return
    }
    if (!secretMatches(candidate)) {
      recordFailure(ip, Date.now())
      if (json) respondJson(res, 401, { error: 'invalid secret' })
      else respondRedirect(res, '/?auth=failed')
      return
    }
    failures.delete(ip)
    const cookie = setCookieValue(createSession(), req)
    if (json) res.writeHead(204, { 'set-cookie': cookie, 'cache-control': 'no-store' }).end()
    else respondRedirect(res, '/', { 'set-cookie': cookie })
  }

  const handleLogout = (req: IncomingMessage, res: ServerResponse): void => {
    const json = wantsJson(req)
    if (enabled) {
      // A forged logout is a nuisance, not a breach, so absent Origin stays
      // allowed like on login — but present-and-foreign is still refused.
      if (originVerdict(req) === 'foreign') {
        respondJson(res, 403, { error: 'origin not allowed' })
        return
      }
      const token = cookieToken(req)
      // Deleting the table entry is the invalidation; clearing the cookie is
      // just tidiness. A stale copy of the token is dead either way.
      if (token !== undefined && token !== '' && sessions.delete(tokenKey(token))) persist()
    }
    const cookie = clearCookieValue(req)
    if (json) res.writeHead(204, { 'set-cookie': cookie, 'cache-control': 'no-store' }).end()
    else respondRedirect(res, '/', { 'set-cookie': cookie })
  }

  const handleAuthRoute = async (pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (pathname === '/auth/status') {
      if (req.method !== 'GET') respondJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      else respondJson(res, 200, { enabled, authenticated: enabled ? hasSession(req) : true })
      return
    }
    if (pathname === '/auth/login') {
      if (req.method !== 'POST') respondJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      else await handleLogin(req, res)
      return
    }
    if (pathname === '/auth/logout') {
      if (req.method !== 'POST') respondJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      else handleLogout(req, res)
      return
    }
    respondJson(res, 404, { error: 'not found' })
  }

  const handleAuthRequest = (req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean> => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      return false
    }
    // Claim the whole /auth prefix (unknown subpaths 404 here) so nothing under
    // it ever falls through to the SPA's catch-all.
    if (pathname !== '/auth' && !pathname.startsWith('/auth/')) return false
    return handleAuthRoute(pathname, req, res).then(() => true)
  }

  // Failure detail rides the redirect query (`/?auth=failed|throttled`), not a
  // server-side flash store: the login page is stateless and the message never
  // says more than the response status already did.
  const loginPage = (req: IncomingMessage): { action: string; field: string; error?: string } => {
    let reason: string | null = null
    try {
      reason = new URL(req.url ?? '/', 'http://internal').searchParams.get('auth')
    } catch {
      reason = null
    }
    const error =
      reason === 'failed'
        ? 'Invalid access key. Try again.'
        : reason === 'throttled'
          ? 'Too many failed attempts. Wait a few minutes, then try again.'
          : undefined
    return { action: '/auth/login', field: 'secret', error }
  }

  return {
    enabled,
    authenticate,
    handleAuthRequest,
    hasValidSession: (req) => (enabled ? hasSession(req) : true),
    loginPage,
  }
}
