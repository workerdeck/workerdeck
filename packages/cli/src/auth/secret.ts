import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isUpgradeRequest } from './origin.ts'

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

// Secret and session tokens are only ever compared as fixed-length digests, so no path compares secret material with
// an early exit.
export function secretMatcher(secret: string | undefined): (candidate: string) => boolean {
  const digest = secret === undefined ? undefined : sha256(secret)
  return (candidate) => digest !== undefined && timingSafeEqual(sha256(candidate), digest)
}

export function headerSecret(req: IncomingMessage): string | undefined {
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

// Upgrades only. A query-string key lands in proxy access logs, so a REST call carrying `?key=` is not
// authenticated by it and must stay that way: a leaked URL then buys one attach and nothing more.
export function querySecret(req: IncomingMessage): string | undefined {
  if (!isUpgradeRequest(req)) {
    return undefined
  }
  const key = new URL(req.url ?? '/', 'http://internal').searchParams.get('key')
  return key !== null && key !== '' ? key : undefined
}
