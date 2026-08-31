import type { ClientOptions } from './index.ts'

/**
 * The `ClientOptions` a **browser** needs to reach a gateway that is not its own origin:
 * `Authorization: Bearer <key>` on REST, `?key=<key>` on the WS upgrade — the weaker transport,
 * confined to the upgrade because a tab cannot header one. A Node host needs none of this.
 * See `docs/PACKAGES.md` §`packages/client`.
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
