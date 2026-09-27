import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Authenticator } from '@workerdeck/server'
import { readBody, respondJson } from '../lib/http.ts'
import {
  clearCookieValue,
  createCookieSessions,
  hasSession,
  mintSession,
  revokeSession,
  setCookieValue,
  type CliSessionStore,
  type CookieSessions,
} from './cookie-sessions.ts'
import {
  clientIp,
  cookieOriginAccepted,
  isCrossSiteBrowserRequest,
  isLoopbackAddress,
  originVerdict,
  parseAllowedOrigins,
  type OriginPolicy,
} from './origin.ts'
import { headerSecret, querySecret, secretMatcher } from './secret.ts'
import { createLoginThrottle, forgiveIp, ipBlockedMs, loginBlockedMs, recordFailure, type LoginThrottle } from './throttle.ts'

export type { CliSessionStore, StoredSession } from './cookie-sessions.ts'

export type CliAuthOptions = {
  // Unset disables auth entirely; that the CLI then binds loopback only is enforced by the caller, not here.
  secret?: string
  // No `__Host-` prefix: it requires `Secure`, and plain-HTTP localhost is the primary deployment.
  cookieName?: string
  // Fixed, never sliding: the auth hooks only see the request, so a renewed cookie has nowhere to ride back on.
  ttlMs?: number
  // Attacker-writable on a directly exposed port, hence off by default - but behind TLS termination it must be on,
  // or `Secure` is skipped and the Origin check computes `http://` where the browser says `https://`.
  trustProxy?: boolean
  allowedOrigins?: string[]
  throttle?: { windowMs?: number; maxFailuresPerIp?: number; maxFailuresGlobal?: number }
  sessions?: CliSessionStore
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

type AuthState = {
  enabled: boolean
  policy: OriginPolicy
  sessions: CookieSessions
  throttle: LoginThrottle
  secretMatches: (candidate: string) => boolean
}

const MIN_SECRET_LENGTH = 12
const DEFAULT_COOKIE_NAME = 'workerdeck_session'
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_THROTTLE_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_MAX_FAILURES_PER_IP = 10
const DEFAULT_MAX_FAILURES_GLOBAL = 100
const MAX_LOGIN_BODY_BYTES = 4096
const OPEN_PRINCIPAL: CliPrincipal = { via: 'open', canManageProfiles: true }

export function createCliAuth(options: CliAuthOptions = {}): CliAuth {
  const state = authState(options)
  const { enabled } = state
  return {
    enabled,
    authenticate: (req) => authenticateRequest(state, req),
    handleAuthRequest: (req, res) => {
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
      return handleAuthRoute(state, pathname, req, res).then(() => true)
    },
    hasValidSession: (req) => (enabled ? hasSession(state.sessions, req) : true),
    loginPage,
  }
}

function authState(options: CliAuthOptions): AuthState {
  const { secret } = options
  if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `createCliAuth: secret must be at least ${MIN_SECRET_LENGTH} characters - ` +
        'use a long random value, or leave it unset to run without auth on loopback',
    )
  }
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!(ttlMs > 0)) {
    throw new Error('createCliAuth: ttlMs must be positive')
  }
  const trustProxy = options.trustProxy === true
  const throttle = createLoginThrottle({
    windowMs: options.throttle?.windowMs ?? DEFAULT_THROTTLE_WINDOW_MS,
    maxFailuresPerIp: options.throttle?.maxFailuresPerIp ?? DEFAULT_MAX_FAILURES_PER_IP,
    maxFailuresGlobal: options.throttle?.maxFailuresGlobal ?? DEFAULT_MAX_FAILURES_GLOBAL,
  })
  const policy: OriginPolicy = { trustProxy, allowedOrigins: parseAllowedOrigins(options.allowedOrigins ?? []) }
  return {
    enabled: secret !== undefined,
    policy,
    sessions: createCookieSessions({ secret, cookieName, ttlMs, trustProxy, store: options.sessions }),
    throttle,
    secretMatches: secretMatcher(secret),
  }
}

function authenticateRequest(state: AuthState, req: IncomingMessage): CliPrincipal | null {
  if (!state.enabled) {
    return isCrossSiteBrowserRequest(req, state.policy) ? null : OPEN_PRINCIPAL
  }
  // The secret is not ambient - the sender chose to attach it - so no Origin check applies, and a
  // present-but-wrong header is a rejection rather than a fall-through to the cookie.
  const provided = headerSecret(req) ?? querySecret(req)
  if (provided !== undefined) {
    return headerAttempt(state, req, provided) ? { via: 'header', canManageProfiles: true } : null
  }
  if (!hasSession(state.sessions, req)) {
    return null
  }
  return cookieOriginAccepted(req, state.policy) ? { via: 'cookie', canManageProfiles: true } : null
}

// Per-IP only, never the global budget: one stale client must not lock the operator's others out. Loopback is exempt
// for the same reason, since a local caller already has the machine and a rotated key leaves every local client stale.
function headerAttempt(state: AuthState, req: IncomingMessage, provided: string): boolean {
  const ip = clientIp(req, state.policy.trustProxy)
  const throttled = !isLoopbackAddress(ip)
  const now = Date.now()
  if (throttled && ipBlockedMs(state.throttle, ip, now) > 0) {
    return false
  }
  if (state.secretMatches(provided)) {
    return true
  }
  if (throttled) {
    recordFailure(state.throttle, ip, now, false)
  }
  return false
}

async function handleAuthRoute(state: AuthState, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (pathname === '/auth/status') {
    if (req.method !== 'GET') {
      respondJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    } else {
      respondJson(res, 200, { enabled: state.enabled, authenticated: state.enabled ? hasSession(state.sessions, req) : true })
    }
    return
  }
  if (pathname === '/auth/login') {
    if (req.method !== 'POST') {
      respondJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    } else {
      await handleLogin(state, req, res)
    }
    return
  }
  if (pathname === '/auth/logout') {
    if (req.method !== 'POST') {
      respondJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    } else {
      handleLogout(state, req, res)
    }
    return
  }
  respondJson(res, 404, { error: 'not found' })
}

async function handleLogin(state: AuthState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = wantsJson(req)
  if (!state.enabled) {
    respondJson(res, 409, { error: 'auth is disabled: no secret is configured' })
    return
  }
  // Refused before touching the throttle, so a hostile page cannot burn a victim IP's budget.
  // Absent Origin stays allowed (curl-style provisioning): a browser forgery always carries one.
  if (originVerdict(req, state.policy) === 'foreign') {
    respondJson(res, 403, { error: 'origin not allowed' })
    return
  }
  const ip = clientIp(req, state.policy.trustProxy)
  const blocked = loginBlockedMs(state.throttle, ip, Date.now())
  if (blocked > 0) {
    const retryAfter = String(Math.ceil(blocked / 1000))
    if (json) {
      respondJson(res, 429, { error: 'too many failed attempts' }, { 'retry-after': retryAfter })
    } else {
      respondRedirect(res, '/?auth=throttled', { 'retry-after': retryAfter })
    }
    return
  }
  const candidate = await readLoginSecret(req, res)
  if (candidate === undefined) {
    return
  }
  if (!state.secretMatches(candidate)) {
    recordFailure(state.throttle, ip, Date.now())
    if (json) {
      respondJson(res, 401, { error: 'invalid secret' })
    } else {
      respondRedirect(res, '/?auth=failed')
    }
    return
  }
  forgiveIp(state.throttle, ip)
  const cookie = setCookieValue(state.sessions, mintSession(state.sessions), req)
  if (json) {
    res.writeHead(204, { 'set-cookie': cookie, 'cache-control': 'no-store' }).end()
  } else {
    respondRedirect(res, '/', { 'set-cookie': cookie })
  }
}

async function readLoginSecret(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  const body = await readBody(req, MAX_LOGIN_BODY_BYTES)
  if (body === null) {
    respondJson(res, 413, { error: 'body too large' })
    // The unread rest of an oversized request would desync the next keep-alive exchange on this socket.
    res.once('finish', () => req.destroy())
    return undefined
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
      return undefined
    }
  } else {
    respondJson(res, 415, { error: 'expected application/x-www-form-urlencoded or application/json' })
    return undefined
  }
  if (typeof candidate !== 'string' || candidate === '') {
    respondJson(res, 400, { error: 'missing secret' })
    return undefined
  }
  return candidate
}

function handleLogout(state: AuthState, req: IncomingMessage, res: ServerResponse): void {
  const json = wantsJson(req)
  if (state.enabled) {
    // A forged logout is a nuisance, not a breach, so an absent Origin is allowed here.
    if (originVerdict(req, state.policy) === 'foreign') {
      respondJson(res, 403, { error: 'origin not allowed' })
      return
    }
    revokeSession(state.sessions, req)
  }
  const cookie = clearCookieValue(state.sessions, req)
  if (json) {
    res.writeHead(204, { 'set-cookie': cookie, 'cache-control': 'no-store' }).end()
  } else {
    respondRedirect(res, '/', { 'set-cookie': cookie })
  }
}

function loginPage(req: IncomingMessage): { action: string; field: string; error?: string } {
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

function respondRedirect(res: ServerResponse, location: string, headers?: Record<string, string>): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers }).end()
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('application/json')
}
