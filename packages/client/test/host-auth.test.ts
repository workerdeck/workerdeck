import { describe, expect, it } from 'vitest'
import { WorkerDeckClient, hostAuth } from '../src/index.ts'

class RecordingSocket {
  static urls: string[] = []
  constructor(url: string) {
    RecordingSocket.urls.push(url)
  }
}

function clientFor(key: string): WorkerDeckClient {
  const baseUrl = 'https://gw.example:8080'
  return new WorkerDeckClient({ baseUrl, ...hostAuth({ baseUrl, key }), WebSocketImpl: RecordingSocket as unknown as typeof WebSocket })
}

describe('hostAuth', () => {
  it('returns nothing for an empty key', () => {
    expect(hostAuth({ baseUrl: 'http://x', key: '' })).toEqual({})
  })

  it('carries truncateResults and imageRefs into the keyed session socket url', () => {
    RecordingSocket.urls = []
    const keyed = clientFor('s3cr&t')
    const open = new WorkerDeckClient({ baseUrl: 'https://gw.example:8080', WebSocketImpl: RecordingSocket as unknown as typeof WebSocket })
    keyed.openSocket('a/b', 7, true, true)
    open.openSocket('a/b', 7, true, true)
    keyed.openSocket('a/b', 0)
    const [withKey, withoutKey, plain] = RecordingSocket.urls
    expect(withKey).toBe(`${withoutKey}&key=s3cr%26t`)
    expect(withoutKey).toBe('wss://gw.example:8080/sessions/a%2Fb/ws?afterSeq=7&truncateResults=1&imageRefs=1')
    expect(plain).toBe('wss://gw.example:8080/sessions/a%2Fb/ws?afterSeq=0&key=s3cr%26t')
  })

  it('keys the queue socket and the bearer header', () => {
    const auth = hostAuth({ baseUrl: 'http://gw', key: 'k' })
    expect(auth.headers).toEqual({ authorization: 'Bearer k' })
    expect(auth.buildQueueWsUrl?.()).toBe('ws://gw/queue/ws?key=k')
  })
})
