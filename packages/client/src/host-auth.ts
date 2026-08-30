import type { ClientOptions } from './index.ts'

/**
 * The `ClientOptions` a **browser** needs to reach a gateway that is not its own
 * origin.
 *
 * Here, beside `apiUrl`, for the same reason that is here: every host that lets
 * someone type a gateway address and a key has to present them identically, or
 * the same gateway works in one client and not another. It is browser-shaped on
 * purpose — a Node host (the VS Code extension) sends the key as a header on
 * both transports and needs none of this.
 *
 * Two transports, because a browser has no choice:
 *
 * - **REST** takes `Authorization: Bearer <key>`, like any service client.
 * - **WebSocket** takes `?key=<key>`, because a tab cannot put a header on an
 *   upgrade handshake and the gateway's cookie belongs to another origin. The
 *   CLI's auth accepts the key this way on upgrades *only*.
 *
 * The query-string transport is the weaker one and is worth naming: unlike a
 * header it is a permanent credential that lands in reverse-proxy access logs.
 * It is confined to the upgrade so what a leaked URL buys is one attach. If a
 * gateway later mints short-lived tickets, only the body of `buildWsUrl`
 * changes — callers of this function do not.
 */
export function hostAuth(options: {
  /** The gateway's API root, as `apiUrl()` returns it (ends in `/v1`). */
  baseUrl: string
  /** The operator's gateway key. Empty means an unauthenticated gateway. */
  key: string
}): Pick<ClientOptions, 'headers' | 'buildWsUrl' | 'buildQueueWsUrl'> {
  const { baseUrl, key } = options
  if (key === '') {
    return {}
  }

  const wsRoot = baseUrl.replace(/^http/, 'ws')
  // Appended with the same `?`/`&` care the default URLs need: the session
  // socket already carries `afterSeq`, the queue socket carries nothing.
  const withKey = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`

  return {
    headers: { authorization: `Bearer ${key}` },
    buildWsUrl: (sessionId, afterSeq) => withKey(`${wsRoot}/sessions/${encodeURIComponent(sessionId)}/ws?afterSeq=${afterSeq}`),
    buildQueueWsUrl: () => withKey(`${wsRoot}/queue/ws`),
  }
}
