import { createHmac, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isSecure } from './origin.ts'
import { sha256 } from './secret.ts'

export type StoredSession = { expiresAt: number }

export type CliSessionStore = {
  initial?: Iterable<[string, StoredSession]>
  save(entries: [string, StoredSession][]): void
  flush?(): Promise<void>
}

export type CookieSessionOptions = {
  secret: string | undefined
  cookieName: string
  ttlMs: number
  trustProxy: boolean
  store?: CliSessionStore
}

export type CookieSessions = CookieSessionOptions & { entries: Map<string, StoredSession> }

// Only successful logins insert, so this cap fences the secret-holder's own memory use and nobody else's.
const MAX_SESSIONS = 100

export function createCookieSessions(options: CookieSessionOptions): CookieSessions {
  const entries = new Map<string, StoredSession>()
  for (const [key, entry] of options.store?.initial ?? []) {
    if (entries.size >= MAX_SESSIONS) {
      break
    }
    entries.set(key, { expiresAt: entry.expiresAt })
  }
  return { ...options, entries }
}

export function mintSession(sessions: CookieSessions): string {
  if (sessions.entries.size >= MAX_SESSIONS) {
    const oldest = sessions.entries.keys().next().value
    if (oldest !== undefined) {
      sessions.entries.delete(oldest)
    }
  }
  const token = randomBytes(32).toString('base64url')
  sessions.entries.set(tokenKey(sessions, token), { expiresAt: Date.now() + sessions.ttlMs })
  persist(sessions)
  return token
}

export function hasSession(sessions: CookieSessions, req: IncomingMessage): boolean {
  const token = cookieToken(sessions, req)
  if (token === undefined || token === '') {
    return false
  }
  const key = tokenKey(sessions, token)
  const entry = sessions.entries.get(key)
  if (entry === undefined) {
    return false
  }
  if (entry.expiresAt <= Date.now()) {
    sessions.entries.delete(key)
    persist(sessions)
    return false
  }
  return true
}

// Deleting the table row is the invalidation; clearing the cookie is only tidiness.
export function revokeSession(sessions: CookieSessions, req: IncomingMessage): void {
  const token = cookieToken(sessions, req)
  if (token !== undefined && token !== '' && sessions.entries.delete(tokenKey(sessions, token))) {
    persist(sessions)
  }
}

export function setCookieValue(sessions: CookieSessions, token: string, req: IncomingMessage): string {
  return [`${sessions.cookieName}=${token}`, `Max-Age=${Math.ceil(sessions.ttlMs / 1000)}`, ...cookieAttributes(sessions, req)].join('; ')
}

export function clearCookieValue(sessions: CookieSessions, req: IncomingMessage): string {
  return [`${sessions.cookieName}=`, 'Max-Age=0', ...cookieAttributes(sessions, req)].join('; ')
}

function persist(sessions: CookieSessions): void {
  sessions.store?.save([...sessions.entries])
}

// Keys are `HMAC-SHA256(secret, token)`; never "simplify" that to a plain digest (`docs/GOTCHAS.md`).
function tokenKey(sessions: CookieSessions, token: string): string {
  return sessions.secret === undefined ? sha256(token).toString('hex') : createHmac('sha256', sessions.secret).update(token).digest('hex')
}

function cookieToken(sessions: CookieSessions, req: IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') {
    return undefined
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      continue
    }
    if (part.slice(0, eq).trim() === sessions.cookieName) {
      return part.slice(eq + 1).trim()
    }
  }
  return undefined
}

// Lax over Strict: Strict drops the cookie on an external top-level navigation, and buys nothing the Origin check
// does not already cover.
function cookieAttributes(sessions: CookieSessions, req: IncomingMessage): string[] {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax']
  if (isSecure(req, sessions.trustProxy)) {
    attrs.push('Secure')
  }
  return attrs
}
