import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { User } from './shared.ts'

/**
 * Three users, in the source, with no passwords. This is a demo login: the point
 * of the app is the *embedding*, and a real one would put Supabase or an OIDC
 * provider here and change nothing downstream — everything after this file deals
 * in a resolved `User`.
 */
export const USERS: readonly User[] = [
  { id: 'ada', name: 'Ada Lovelace', avatar: '🧮' },
  { id: 'grace', name: 'Grace Hopper', avatar: '🐛' },
  { id: 'alan', name: 'Alan Turing', avatar: '🧩' },
]

export const userById = (id: string | undefined): User | undefined =>
  USERS.find((u) => u.id === id)

export const SESSION_COOKIE = 'embedded_user'

/**
 * A cookie the server signs and the browser cannot forge.
 *
 * Signed rather than random-and-stored because the cookie *is* the whole session
 * table otherwise, and a restart would log everyone out — which would make the
 * gateway's own restart story impossible to demo. The secret is per-process
 * unless `EMBEDDED_SECRET` is set, so a restart without one does log everyone
 * out; that is the honest trade and it is one line to change.
 */
export function createCookieAuth(secret: string = randomBytes(32).toString('hex')) {
  const sign = (value: string): string =>
    createHmac('sha256', secret).update(value).digest('base64url')

  return {
    /** `Set-Cookie` value for a login. */
    issue(userId: string): string {
      const token = `${userId}.${sign(userId)}`
      // No `Secure`: the demo runs on loopback http. Add it (and a real domain)
      // the moment this is served over TLS. `SameSite=Lax` is necessary and
      // *not* sufficient — it stops cross-site but not same-site, and a page on
      // another port of the same site sends this cookie. Every cookie-authed
      // surface therefore checks `sameOrigin` itself; see it for the rest.
      return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    },
    /** `Set-Cookie` value for a logout. */
    clear(): string {
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    },
    /** The user a request is authenticated as, or undefined. */
    resolve(req: Pick<IncomingMessage, 'headers'>): User | undefined {
      const raw = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (!raw) return undefined
      const at = raw.lastIndexOf('.')
      if (at <= 0) return undefined
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
 * **The guard every cookie-authenticated surface must apply**, and the reason
 * `SameSite=Lax` is not the whole CSRF story.
 *
 * A cookie rides any request the browser is induced to send, including one a
 * third party's page caused, and `Lax` only stops *cross-site* — a page on
 * another port of the same site is same-site, so its `fetch` carries this
 * cookie. A "simple" request (`content-type: text/plain`) is not preflighted,
 * so CORS never gets a say either, and the attacker does not need to read the
 * response: the side effect is the damage. That matters most on the gateway,
 * where a forged `POST /v1/sessions` would run a prompt of the attacker's
 * choosing as the victim, with the victim's own wiki tools.
 *
 * `Sec-Fetch-Site` is the modern signal and every browser this app targets
 * sends it; `Origin` is the fallback for a request that carries one instead. A
 * request with neither is not a browser request, and these surfaces exist for
 * browsers — the agent reaches its own on a bearer token.
 *
 * Callers should **decline** (return null) rather than throw, so a forged
 * request gets a plain 401 that explains nothing to whoever sent it.
 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>): boolean {
  const site = req.headers['sec-fetch-site']
  // 'none' is a direct navigation (the user typed the URL); 'same-origin' is the
  // SPA's own fetch. 'same-site' and 'cross-site' are not this app's.
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
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

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}
