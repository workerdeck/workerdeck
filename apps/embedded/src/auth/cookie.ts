import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { User } from '../shared.ts'
import { userById } from './users.ts'

export const SESSION_COOKIE = 'embedded_user'

// The random default secret is for a throwaway caller (a test); a real one must outlive the process (`resolveSecret`).
export function createCookieAuth(secret: string = randomBytes(32).toString('hex')) {
  const sign = (value: string): string => createHmac('sha256', secret).update(value).digest('base64url')

  return {
    issue(userId: string): string {
      const token = `${userId}.${sign(userId)}`
      // No `Secure`: the demo runs on loopback http — add it the moment this is served over TLS.
      return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    },
    clear(): string {
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    },
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
      // Length check first: timingSafeEqual throws on a length mismatch, and a forged cookie must not 500 the route.
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return undefined
      }
      return userById(userId)
    },
  }
}

export type CookieAuth = ReturnType<typeof createCookieAuth>

// The CSRF guard every cookie-authenticated surface here must apply: `SameSite=Lax` stops cross-site only, and a page
// on another port of the same site rides this cookie unpreflighted. Callers decline rather than throw, so a forged
// request falls through to a plain 401.
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>): boolean {
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

export function readCookie(header: string | undefined, name: string): string | undefined {
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
