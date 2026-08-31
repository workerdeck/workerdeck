import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerDeckClient, WorkerDeckError } from '../src/index.ts'

// A socket the test drives by hand. The handles only ever touch onopen/onmessage/onclose/onerror,
// readyState and send/close, so this stands in for the whole WebSocket surface they depend on.
class FakeSocket {
  static opened: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  readonly sent: string[] = []
  closed = false

  constructor(readonly url: string) {
    FakeSocket.opened.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.closed = true
  }

  accept(): void {
    this.readyState = 1
    this.onopen?.()
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

const SocketImpl = FakeSocket as unknown as typeof WebSocket

const makeClient = (fetchImpl?: typeof fetch) => new WorkerDeckClient({ baseUrl: 'http://host/v1', WebSocketImpl: SocketImpl, fetchImpl })

const latest = () => FakeSocket.opened.at(-1)!

// The handles defer their first connect a tick, so nothing exists until timers run.
const settle = () => vi.advanceTimersByTime(0)

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.opened = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handle listener registry', () => {
  it('unsubscribes only the listener that was returned for', () => {
    const handle = makeClient().attach('s1')
    settle()
    const seen: string[] = []
    const off = handle.on('connectionChange', () => seen.push('a'))
    handle.on('connectionChange', () => seen.push('b'))

    latest().accept()
    expect(seen).toEqual(['a', 'b'])

    off()
    latest().drop()
    expect(seen).toEqual(['a', 'b', 'b'])
    handle.detach()
  })

  it('delivers to every listener even when one throws', () => {
    const handle = makeClient().attach('s1')
    settle()
    const seen: string[] = []
    handle.on('connectionChange', () => {
      throw new Error('listener exploded')
    })
    handle.on('connectionChange', () => seen.push('after'))

    expect(() => latest().accept()).not.toThrow()
    expect(seen).toEqual(['after'])
    handle.detach()
  })
})

describe('SessionHandle reconnect', () => {
  it('backs off 500ms doubling to a 10s ceiling, and counts each attempt', () => {
    const handle = makeClient().attach('s1')
    settle()
    const attempts: number[] = []
    handle.on('reconnectAttempt', (n) => attempts.push(n))

    // Each drop schedules the next connect; the delay is what we are pinning.
    const delays = [500, 1000, 2000, 4000, 8000, 10_000, 10_000]
    for (const [index, delay] of delays.entries()) {
      const before = FakeSocket.opened.length
      latest().drop()
      // One tick short of the delay must not have reconnected yet.
      vi.advanceTimersByTime(delay - 1)
      expect(FakeSocket.opened.length, `attempt ${index + 1} fired early`).toBe(before)
      vi.advanceTimersByTime(1)
      expect(FakeSocket.opened.length, `attempt ${index + 1} did not fire`).toBe(before + 1)
    }
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7])
    handle.detach()
  })

  it('resets the backoff once a connection opens', () => {
    const handle = makeClient().attach('s1')
    settle()
    latest().drop()
    vi.advanceTimersByTime(500)
    latest().drop()
    vi.advanceTimersByTime(1000)

    latest().accept()
    const before = FakeSocket.opened.length
    latest().drop()
    vi.advanceTimersByTime(500)
    expect(FakeSocket.opened.length).toBe(before + 1)
    handle.detach()
  })

  it('does not reconnect when reconnect is off, nor after detach', () => {
    const noReconnect = makeClient().attach('s1', { reconnect: false })
    settle()
    const afterOpen = FakeSocket.opened.length
    latest().drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.opened.length).toBe(afterOpen)
    noReconnect.detach()

    const handle = makeClient().attach('s2')
    settle()
    const socket = latest()
    handle.detach()
    expect(socket.closed).toBe(true)
    socket.drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.opened.at(-1)).toBe(socket)
  })

  it('reconnectNow cancels the pending backoff and restarts it from 500ms', () => {
    const handle = makeClient().attach('s1')
    settle()
    latest().drop()
    vi.advanceTimersByTime(500)
    latest().drop()

    const before = FakeSocket.opened.length
    handle.reconnectNow()
    expect(FakeSocket.opened.length).toBe(before + 1)

    // The pending 1000ms timer must have been cleared, not merely raced.
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.opened.length).toBe(before + 1)

    latest().drop()
    vi.advanceTimersByTime(500)
    expect(FakeSocket.opened.length).toBe(before + 2)
    handle.detach()
  })

  it('is a no-op when reconnectNow is called on a live socket', () => {
    const handle = makeClient().attach('s1')
    settle()
    latest().accept()
    const before = FakeSocket.opened.length
    handle.reconnectNow()
    expect(FakeSocket.opened.length).toBe(before)
    handle.detach()
  })
})

describe('SessionHandle framing', () => {
  it('queues sends made before the socket opens and flushes them in order', () => {
    const handle = makeClient().attach('s1')
    settle()
    handle.send('first')
    handle.send('second')
    expect(latest().sent).toEqual([])

    latest().accept()
    const texts = latest().sent.map((raw) => (JSON.parse(raw) as { text: string }).text)
    expect(texts).toEqual(['first', 'second'])

    handle.send('third')
    expect(latest().sent).toHaveLength(3)
    handle.detach()
  })

  it('advances lastSeq and drops events that replay at or below it', () => {
    const handle = makeClient().attach('s1', { afterSeq: 5 })
    settle()
    const seqs: number[] = []
    handle.on('event', (event) => seqs.push(event.seq))

    latest().deliver({ type: 'event', event: { seq: 4 } })
    latest().deliver({ type: 'event', event: { seq: 5 } })
    latest().deliver({ type: 'event', event: { seq: 6 } })
    latest().deliver({ type: 'event', event: { seq: 6 } })
    latest().deliver({ type: 'event', event: { seq: 7 } })

    expect(seqs).toEqual([6, 7])
    expect(handle.lastSeq).toBe(7)
    handle.detach()
  })

  it('reattaches from lastSeq rather than the seq it was constructed with', () => {
    const handle = makeClient().attach('s1', { afterSeq: 5 })
    settle()
    latest().deliver({ type: 'event', event: { seq: 9 } })
    latest().drop()
    vi.advanceTimersByTime(500)
    expect(latest().url).toContain('afterSeq=9')
    handle.detach()
  })

  it('routes each server frame to its own event', () => {
    const handle = makeClient().attach('s1')
    settle()
    const seen: string[] = []
    handle.on('attached', () => seen.push('attached'))
    handle.on('toolCallRequest', () => seen.push('toolCallRequest'))
    handle.on('toolCallCanceled', (payload) => seen.push(`canceled:${payload.executionId}:${payload.reason}`))
    handle.on('protocolError', (message) => seen.push(`error:${message}`))

    latest().deliver({ type: 'attached' })
    latest().deliver({ type: 'tool_call_request' })
    latest().deliver({ type: 'tool_call_canceled', executionId: 'e1', reason: 'timeout' })
    latest().deliver({ type: 'protocol_error', message: 'bad frame' })

    expect(seen).toEqual(['attached', 'toolCallRequest', 'canceled:e1:timeout', 'error:bad frame'])
    handle.detach()
  })
})

describe('QueueHandle', () => {
  it('backs off on the same ladder as SessionHandle', () => {
    const handle = makeClient().attachQueue()
    settle()
    for (const delay of [500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
      const before = FakeSocket.opened.length
      latest().drop()
      vi.advanceTimersByTime(delay - 1)
      expect(FakeSocket.opened.length).toBe(before)
      vi.advanceTimersByTime(1)
      expect(FakeSocket.opened.length).toBe(before + 1)
    }
    handle.detach()
  })

  it('emits stats alongside attached, and honours reconnect: false', () => {
    const handle = makeClient().attachQueue()
    settle()
    const seen: string[] = []
    handle.on('attached', () => seen.push('attached'))
    handle.on('stats', () => seen.push('stats'))
    handle.on('event', () => seen.push('event'))

    latest().deliver({ type: 'queue_attached', stats: { pending: 0 } })
    latest().deliver({ type: 'job_event', event: {} })
    latest().deliver({ type: 'queue_stats', stats: { pending: 1 } })
    expect(seen).toEqual(['attached', 'stats', 'event', 'stats'])
    handle.detach()

    const once = makeClient().attachQueue({ reconnect: false })
    settle()
    const before = FakeSocket.opened.length
    latest().drop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.opened.length).toBe(before)
    once.detach()
  })
})

describe('error mapping', () => {
  const respond = (status: number, body: unknown, ok = status < 400) =>
    ({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(''),
      blob: () => Promise.resolve({}),
    }) as unknown as Response

  it('raises the server error text and status from a JSON route', async () => {
    const client = makeClient(() => Promise.resolve(respond(403, { error: 'scope refused' })))
    await expect(client.listSessions()).rejects.toMatchObject({ name: 'WorkerDeckError', message: 'scope refused', status: 403 })
  })

  it('falls back to a method-and-path message when the body carries no error', async () => {
    const client = makeClient(() => Promise.resolve(respond(500, {})))
    await expect(client.listSessions()).rejects.toThrow('GET /sessions failed with 500')
  })

  it('survives a body that is not JSON at all', async () => {
    const client = makeClient(() =>
      Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) } as unknown as Response),
    )
    await expect(client.listSessions()).rejects.toBeInstanceOf(WorkerDeckError)
  })

  it('maps byte routes onto the same error type with their own message', async () => {
    const client = makeClient(() => Promise.resolve(respond(404, {})))
    await expect(client.projectIcon('s1')).rejects.toMatchObject({ name: 'WorkerDeckError', status: 404 })
    await expect(client.projectIcon('s1')).rejects.toThrow('project icon request failed with 404')
    await expect(client.readProducedFile('s1', 'f1')).rejects.toThrow('produced file request failed with 404')
    await expect(client.fetchSessionFile('s1', 'a.txt')).rejects.toThrow('GET file failed with 404')
    await expect(client.toolResultImage('s1', 1, 't1', 0)).rejects.toThrow('image part request failed with 404')
  })
})
