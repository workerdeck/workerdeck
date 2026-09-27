import type { ClientOptions } from './index.ts'
import { sessionWsUrl } from './ws-url.ts'

export function hostAuth(options: { baseUrl: string; key: string }): Pick<ClientOptions, 'headers' | 'buildWsUrl' | 'buildQueueWsUrl'> {
  const { baseUrl, key } = options
  if (key === '') {
    return {}
  }

  const wsRoot = baseUrl.replace(/^http/, 'ws')
  const withKey = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`

  return {
    headers: { authorization: `Bearer ${key}` },
    buildWsUrl: (sessionId, afterSeq, truncateResults, imageRefs) =>
      withKey(sessionWsUrl(baseUrl, sessionId, afterSeq, truncateResults, imageRefs)),
    buildQueueWsUrl: () => withKey(`${wsRoot}/queue/ws`),
  }
}
