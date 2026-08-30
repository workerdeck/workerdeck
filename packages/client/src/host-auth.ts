import type { ClientOptions } from './index.ts'

/**
 * The `ClientOptions` a **browser** needs to reach a gateway that is not its own
 * origin. Browser-shaped on purpose — a Node host sends the key as a header on both
 * transports and needs none of this.
 *
 * - **REST** takes `Authorization: Bearer <key>`.
 * - **WebSocket** takes `?key=<key>`: a tab cannot put a header on an upgrade
 *   handshake, and the CLI's auth accepts the key this way on upgrades *only*.
 *
 * The query-string transport is the weaker one: unlike a header it is a permanent
 * credential that lands in reverse-proxy access logs, so it stays confined to the
 * upgrade — what a leaked URL buys is one attach.
 */
export const hostAuth = (options: {
  /** The gateway's API root, as `apiUrl()` returns it (ends in `/v1`). */
  baseUrl: string
  /** The operator's gateway key. Empty means an unauthenticated gateway. */
  key: string
}): Pick<ClientOptions, 'headers' | 'buildWsUrl' | 'buildQueueWsUrl'> => {
  const { baseUrl, key } = options
  if (key === '') {
    return {}
  }

  const wsRoot = baseUrl.replace(/^http/, 'ws')
  const withKey = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`

  return {
    headers: { authorization: `Bearer ${key}` },
    buildWsUrl: (sessionId, afterSeq) => withKey(`${wsRoot}/sessions/${encodeURIComponent(sessionId)}/ws?afterSeq=${afterSeq}`),
    buildQueueWsUrl: () => withKey(`${wsRoot}/queue/ws`),
  }
}
