import type { ClientOptions } from './index.ts'

export const hostAuth = (options: { baseUrl: string; key: string }): Pick<ClientOptions, 'headers' | 'buildWsUrl' | 'buildQueueWsUrl'> => {
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
