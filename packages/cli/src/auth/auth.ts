import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Authenticator } from '@workerdeck/server'

export type CliAuthOptions = {
  // Unset disables auth entirely; that the CLI then binds loopback only is enforced by the caller, not here.
  secret?: string
  // No `__Host-` prefix: it requires `Secure`, and plain-HTTP localhost is the primary deployment.
  cookieName?: string
  // Fixed, never sliding: the auth hooks only see the request, so a renewed cookie has nowhere to ride back on.
  ttlMs?: number
  // Attacker-writable on a directly exposed port, hence off by default — but behind TLS termination it must be on,
  // or `Secure` is skipped and the Origin check computes `http://` where the browser says `https://`.
  trustProxy?: boolean
  allowedOrigins?: string[]
  throttle?: { windowMs?: number; maxFailuresPerIp?: number; maxFailuresGlobal?: number }
  sessions?: CliSessionStore
}

export type StoredSession = { expiresAt: number }

export type CliSessionStore = {
  initial?: Iterable<[string, StoredSession]>
  save(entries: [string, StoredSession][]): void
  flush?(): Promise<void>
}

export type CliPrincipal = {
  via: 'header' | 'cookie' | 'open'
  // One secret, one trust level: whoever holds it is the operator (still bounded by `allowedConfigDirRoots`).
  canManageProfiles: true
}

export type CliAuth = {
  enabled: boolean
  authenticate: Authenticator
  // Claims `/auth` and everything under it; the static host must call this before anything else.
  handleAuthRequest(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>
  // Gating the SPA shell is UX, not security: every byte of data sits behind `authenticate`.
  hasValidSession(req: IncomingMessage): boolean
  loginPage(req: IncomingMessage): { action: string; field: string; error?: string }
}

const MIN_SECRET_LENGTH = 12
const DEFAULT_COOKIE_NAME = 'workerdeck_session'
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_THROTTLE_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_MAX_FAILURES_PER_IP = 10
const DEFAULT_MAX_FAILURES_GLOBAL = 100
// Only successful logins insert, so this cap fences the secret-holder's own memory use and nobody else's.
const MAX_SESSIONS = 100
const MAX_LOGIN_BODY_BYTES = 4096
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

export const createCliAuth = (options: CliAuthOptions = {}): CliAuth => {
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
  if (!(ttlMs > 0)) {
    throw new Error('createCliAuth: ttlMs must be positive')
  }
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

  // Secret and session tokens are only ever compared as fixed-length digests, so no path compares secret material with an early exit.
  const secretDigest = secret === undefined ? undefined : sha256(secret)
  const secretMatches = (candidate: string): boolean => secretDigest !== undefined && timingSafeEqual(sha256(candidate), secretDigest)

  // Keys are `HMAC-SHA256(secret, token)`; never "simplify" that to a plain digest (`docs/GOTCHAS.md`).
  const sessions = new Map<string, StoredSession>()
  const store = options.sessions
  const tokenKey = (token: string): string =>
    secret === undefined ? sha256(token).toString('hex') : createHmac('sha256', secret).update(token).digest('hex')

  if (store?.initial !== undefined) {
    for (const [key, entry] of store.initial) {
      if (sessions.size >= MAX_SESSIONS) {
        break
      }
      sessions.set(key, { expiresAt: entry.expiresAt })
    }
  }

  const persist = (): void => store?.save([...sessions])

  const createSession = (): string => {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) {
        sessions.delete(oldest)
      }
    }
    const token = randomBytes(32).toString('base64url')
    sessions.set(tokenKey(token), { expiresAt: Date.now() + ttlMs })
    persist()
    return token
  }

  const cookieToken = (req: IncomingMessage): string | undefined => {
    const header = req.headers.cookie
    if (typeof header !== 'string') {
      return undefined
    }
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) {
        continue
      }
      if (part.slice(0, eq).trim() === cookieName) {
        return part.slice(eq + 1).trim()
      }
    }
    return undefined
  }

  const hasSession = (req: IncomingMessage): boolean => {
    const token = cookieToken(req)
    if (token === undefined || token === '') {
      return false
    }
    const key = tokenKey(token)
    const entry = sessions.get(key)
    if (entry === undefined) {
      return false
    }
    if (entry.expiresAt <= Date.now()) {
      sessions.delete(key)
      persist()
      return false
    }
    return true
  }

  // The last value is the one the trusted proxy appended; every earlier position is client-writable.
  const forwardedLast = (value: string | string[] | undefined): string | undefined => {
    if (value === undefined) {
      return undefined
    }
    const joined = Array.isArray(value) ? value.join(',') : value
    const last = joined.split(',').at(-1)?.trim()
    return last === '' ? undefined : last
  }

  const isSecure = (req: IncomingMessage): boolean => {
    if ((req.socket as { encrypted?: boolean }).encrypted === true) {
      return true
    }
    return trustProxy && forwardedLast(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https'
  }

  const expectedOrigin = (req: IncomingMessage): string | null => {
    const host = (trustProxy ? forwardedLast(req.headers['x-forwarded-host']) : undefined) ?? req.headers.host
    if (host === undefined || host === '') {
      return null
    }
    try {
      return new URL(`${isSecure(req) ? 'https' : 'http'}://${host}`).origin
    } catch {
      return null
    }
  }

  // Tri-state on purpose: absence means a non-browser client, because a browser sends Origin on every cross-site POST
  // and every upgrade. Each call site decides what to make of that; `null` and unparseable are foreign.
  const originVerdict = (req: IncomingMessage): 'absent' | 'ok' | 'foreign' => {
    const raw = req.headers.origin
    if (raw === undefined) {
      return 'absent'
    }
    let origin: string
    try {
      origin = new URL(raw).origin
    } catch {
      return 'foreign'
    }
    if (allowedOrigins.has(origin)) {
      return 'ok'
    }
    const expected = expectedOrigin(req)
    return expected !== null && origin === expected ? 'ok' : 'foreign'
  }

  const headerSecret = (req: IncomingMessage): string | undefined => {
    const key = req.headers['x-workerdeck-key']
    if (typeof key === 'string' && key !== '') {
      return key
    }
    const authorization = req.headers.authorization
    if (typeof authorization === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authorization)
      if (match !== null) {
        return match[1]
      }
    }
    return undefined
  }

  const openPrincipal: CliPrincipal = { via: 'open', canManageProfiles: true }

  const isUpgradeRequest = (req: IncomingMessage): boolean => {
    const upgrade = req.headers.upgrade
    return typeof upgrade === 'string' && upgrade.toLowerCase().includes('websocket')
  }

  // Upgrades only. A query-string key lands in proxy access logs, so a REST call carrying `?key=` is not
  // authenticated by it and must stay that way: a leaked URL then buys one attach and nothing more.
  const querySecret = (req: IncomingMessage): string | undefined => {
    if (!isUpgradeRequest(req)) {
      return undefined
    }
    const key = new URL(req.url ?? '/', 'http://internal').searchParams.get('key')
    return key !== null && key !== '' ? key : undefined
  }

  const authenticate: Authenticator = (req) => {
    if (!enabled) {
      return openPrincipal
    }
    // The secret is not ambient — the sender chose to attach it — so no Origin check applies, and a
    // present-but-wrong header is a rejection rather than a fall-through to the cookie.
    const provided = headerSecret(req) ?? querySecret(req)
    if (provided !== undefined) {
      return secretMatches(provided) ? ({ via: 'header', canManageProfiles: true } satisfies CliPrincipal) : null
    }
    if (!hasSession(req)) {
      return null
    }
    const verdict = originVerdict(req)
    // A cookie-authenticated request must never carry a foreign Origin, whatever the method.
    if (verdict === 'foreign') {
      return null
    }
    // Unsafe methods and upgrades additionally require Origin *present*: browsers always send it
    // there, so absence means a non-browser client replaying the cookie.
    const isUpgrade = isUpgradeRequest(req)
    const unsafe = !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())
    if ((isUpgrade || unsafe) && verdict !== 'ok') {
      return null
    }
    return { via: 'cookie', canManageProfiles: true } satisfies CliPrincipal
  }

  // A global cap sits behind the per-IP one because rotating IPs is trivial over IPv6.
  const failures = new Map<string, { count: number; windowStart: number }>()
  const globalFailures = { count: 0, windowStart: 0 }

  const clientIp = (req: IncomingMessage): string =>
    (trustProxy ? forwardedLast(req.headers['x-forwarded-for']) : undefined) ?? req.socket.remoteAddress ?? 'unknown'

  const blockedMs = (entry: { count: number; windowStart: number } | undefined, max: number, now: number): number =>
    entry !== undefined && entry.count >= max && now - entry.windowStart < windowMs ? entry.windowStart + windowMs - now : 0

  const loginBlockedMs = (ip: string, now: number): number =>
    Math.max(blockedMs(failures.get(ip), maxFailuresPerIp, now), blockedMs(globalFailures, maxFailuresGlobal, now))

  const recordFailure = (ip: string, now: number): void => {
    if (failures.size > 256) {
      for (const [key, entry] of failures) {
        if (now - entry.windowStart >= windowMs) {
          failures.delete(key)
        }
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
    // Lax over Strict: Strict drops the cookie on an external top-level navigation, and buys nothing
    // the Origin check does not already cover.
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax']
    if (isSecure(req)) {
      attrs.push('Secure')
    }
    return attrs
  }

  const setCookieValue = (token: string, req: IncomingMessage): string =>
    [`${cookieName}=${token}`, `Max-Age=${Math.ceil(ttlMs / 1000)}`, ...cookieAttributes(req)].join('; ')

  const clearCookieValue = (req: IncomingMessage): string => [`${cookieName}=`, 'Max-Age=0', ...cookieAttributes(req)].join('; ')

  const respondJson = (res: ServerResponse, status: number, body: Record<string, unknown>, headers?: Record<string, string>): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body))
  }

  const respondRedirect = (res: ServerResponse, location: string, headers?: Record<string, string>): void => {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...headers }).end()
  }

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
    // Refused before touching the throttle, so a hostile page cannot burn a victim IP's budget.
    // Absent Origin stays allowed (curl-style provisioning): a browser forgery always carries one.
    if (originVerdict(req) === 'foreign') {
      respondJson(res, 403, { error: 'origin not allowed' })
      return
    }
    const ip = clientIp(req)
    const blocked = loginBlockedMs(ip, Date.now())
    if (blocked > 0) {
      const retryAfter = String(Math.ceil(blocked / 1000))
      if (json) {
        respondJson(res, 429, { error: 'too many failed attempts' }, { 'retry-after': retryAfter })
      } else {
        respondRedirect(res, '/?auth=throttled', { 'retry-after': retryAfter })
      }
      return
    }
    const body = await readBody(req, MAX_LOGIN_BODY_BYTES)
    if (body === null) {
      respondJson(res, 413, { error: 'body too large' })
      // The unread rest of an oversized request would desync the next keep-alive exchange on this socket.
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
      if (json) {
        respondJson(res, 401, { error: 'invalid secret' })
      } else {
        respondRedirect(res, '/?auth=failed')
      }
      return
    }
    failures.delete(ip)
    const cookie = setCookieValue(createSession(), req)
    if (json) {
      res.writeHead(204, { 'set-cookie': cookie, 'cache-control': 'no-store' }).end()
    } else {
      respondRedirect(res, '/', { 'set-cookie': cookie })
    }
  }

  const handleLogout = (req: IncomingMessage, res: ServerResponse): void => {
    const json = wantsJson(req)
    if (enabled) {
      // A forged logout is a nuisance, not a breach, so an absent Origin is allowed here.
      if (originVerdict(req) === 'foreign') {
        respondJson(res, 403, { error: 'origin not allowed' })
        return
      }
      const token = cookieToken(req)
      // Deleting the table row is the invalidation; clearing the cookie is only tidiness.
      if (token !== undefined && token !== '' && sessions.delete(tokenKey(token))) {
        persist()
      }
    }
    const cookie = clearCookieValue(req)
    if (json) {
      res.writeHead(204, { 'set-cookie': cookie, 'cache-control': 'no-store' }).end()
    } else {
      respondRedirect(res, '/', { 'set-cookie': cookie })
    }
  }

  const handleAuthRoute = async (pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (pathname === '/auth/status') {
      if (req.method !== 'GET') {
        respondJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      } else {
        respondJson(res, 200, { enabled, authenticated: enabled ? hasSession(req) : true })
      }
      return
    }
    if (pathname === '/auth/login') {
      if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      } else {
        await handleLogin(req, res)
      }
      return
    }
    if (pathname === '/auth/logout') {
      if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      } else {
        handleLogout(req, res)
      }
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
    // The whole prefix is claimed, unknown subpaths included, so nothing under it falls through to the SPA catch-all.
    if (pathname !== '/auth' && !pathname.startsWith('/auth/')) {
      return false
    }
    return handleAuthRoute(pathname, req, res).then(() => true)
  }

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
