import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { User } from '../shared.ts'
import { userById } from './users.ts'

export const SESSION_COOKIE = 'embedded_user'

/**
 * A signed cookie, so there is no session table and a restart does not log
 * everyone out. The secret must therefore outlive the process — see
 * `resolveSecret`; the random default is for a throwaway caller (a test).
 */
export const createCookieAuth = (secret: string = randomBytes(32).toString('hex')) => {
  const sign = (value: string): string => createHmac('sha256', secret).update(value).digest('base64url')

  return {
    /** `Set-Cookie` value for a login. */
    issue(userId: string): string {
      const token = `${userId}.${sign(userId)}`
      // No `Secure`: the demo runs on loopback http — add it the moment this is served over TLS.
      // `SameSite=Lax` is necessary and *not* sufficient (a page on another port of the same site
      // sends this cookie), so every cookie-authed surface also checks `sameOrigin`.
      return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    },
    /** `Set-Cookie` value for a logout. */
    clear(): string {
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    },
    /** The user a request is authenticated as, or undefined. */
    resolve(req: Pick<IncomingMessage, 'headers'>): User | undefined {
      const raw = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (!raw) {
        return undefined
      }
      const at = raw.lastIndexOf('.')
      if (at <= 0) {
        return undefined
      }
      const userId = raw.slice(0, at)
      const provided = Buffer.from(raw.slice(at + 1))
      const expected = Buffer.from(sign(userId))
      // Length check first: timingSafeEqual throws on a mismatch rather than
      // returning false, and a forged cookie must not 500 the route.
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return undefined
      }
      return userById(userId)
    },
  }
}

export type CookieAuth = ReturnType<typeof createCookieAuth>

/**
 * **The CSRF guard every cookie-authenticated surface must apply.** `SameSite=Lax`
 * stops cross-site only; a simple request from another port of the same site rides
 * this cookie unpreflighted, and on the gateway a forged `POST /v1/sessions` would
 * run the attacker's prompt as the victim with the victim's own wiki tools.
 * A request with neither `Sec-Fetch-Site` nor `Origin` is not a browser request, and
 * these surfaces exist for browsers — the agent reaches its own on a bearer token.
 * Callers must **decline** rather than throw, so a forged request gets a plain 401.
 */
export const sameOrigin = (req: Pick<IncomingMessage, 'headers'>): boolean => {
  const site = req.headers['sec-fetch-site']
  // 'none' is a direct navigation; 'same-origin' is the SPA's own fetch.
  if (typeof site === 'string') {
    return site === 'same-origin' || site === 'none'
  }
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    const host = req.headers.host
    try {
      return Boolean(host) && new URL(origin).host === host
    } catch {
      return false
    }
  }
  return false
}

export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) {
    return undefined
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      continue
    }
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}
