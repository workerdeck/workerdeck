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
      // the moment this is served over TLS. SameSite=Lax is enough here — every
      // state-changing route is a same-origin fetch from the SPA.
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

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}
