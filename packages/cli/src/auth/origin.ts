import type { IncomingMessage } from 'node:http'

export type OriginPolicy = { trustProxy: boolean; allowedOrigins: Set<string> }

// Tri-state on purpose: absence means a non-browser client, because a browser sends Origin on every cross-site POST
// and every upgrade. Each call site decides what to make of that; `null` and unparseable are foreign.
export type OriginVerdict = 'absent' | 'ok' | 'foreign'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function parseAllowedOrigins(entries: string[]): Set<string> {
  return new Set(
    entries.map((entry) => {
      try {
        return new URL(entry).origin
      } catch {
        throw new Error(`createCliAuth: allowedOrigins entry is not a valid origin: ${JSON.stringify(entry)}`)
      }
    }),
  )
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')
}

// The last value is the one the trusted proxy appended; every earlier position is client-writable.
export function forwardedLast(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const joined = Array.isArray(value) ? value.join(',') : value
  const last = joined.split(',').at(-1)?.trim()
  return last === '' ? undefined : last
}

export function isSecure(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) {
    return true
  }
  return trustProxy && forwardedLast(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https'
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  return (trustProxy ? forwardedLast(req.headers['x-forwarded-for']) : undefined) ?? req.socket.remoteAddress ?? 'unknown'
}

export function isUpgradeRequest(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade
  return typeof upgrade === 'string' && upgrade.toLowerCase().includes('websocket')
}

export function isUnsafeMethod(req: IncomingMessage): boolean {
  return !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())
}

export function originVerdict(req: IncomingMessage, policy: OriginPolicy): OriginVerdict {
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
  if (policy.allowedOrigins.has(origin)) {
    return 'ok'
  }
  const expected = expectedOrigin(req, policy.trustProxy)
  return expected !== null && origin === expected ? 'ok' : 'foreign'
}

// A keyless gateway has no credential for a hostile page to lack, so where the request came from is the whole
// defense: a foreign Origin, or a cross-site unsafe request with none, is a drive-by and never reaches `/v1`.
export function isCrossSiteBrowserRequest(req: IncomingMessage, policy: OriginPolicy): boolean {
  if (originVerdict(req, policy) === 'foreign') {
    return true
  }
  return (isUnsafeMethod(req) || isUpgradeRequest(req)) && req.headers['sec-fetch-site'] === 'cross-site'
}

// A cookie-authenticated request must never carry a foreign Origin, whatever the method. Unsafe methods and upgrades
// additionally require Origin *present*: browsers always send it there, so absence means a non-browser client
// replaying the cookie.
export function cookieOriginAccepted(req: IncomingMessage, policy: OriginPolicy): boolean {
  const verdict = originVerdict(req, policy)
  if (verdict === 'foreign') {
    return false
  }
  return !((isUpgradeRequest(req) || isUnsafeMethod(req)) && verdict !== 'ok')
}

function expectedOrigin(req: IncomingMessage, trustProxy: boolean): string | null {
  const host = (trustProxy ? forwardedLast(req.headers['x-forwarded-host']) : undefined) ?? req.headers.host
  if (host === undefined || host === '') {
    return null
  }
  try {
    return new URL(`${isSecure(req, trustProxy) ? 'https' : 'http'}://${host}`).origin
  } catch {
    return null
  }
}
