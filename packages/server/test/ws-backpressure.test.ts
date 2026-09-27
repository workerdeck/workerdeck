import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { Runner } from '@workerdeck/core'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import type { ServerContext } from '../src/context.ts'
import { attachClient, SESSION_SOCKET_BACKPRESSURE_CODE, SESSION_SOCKET_BUFFERED_MAX } from '../src/routes/ws.ts'
import { fakeRunner } from './helpers.ts'

type FakeSocket = EventEmitter & {
  OPEN: 1
  readyState: number
  bufferedAmount: number
  sent: string[]
  send: (data: string) => void
  close: ReturnType<typeof vi.fn>
}

function fakeSocket(): FakeSocket {
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1 as const,
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    send: (data: string) => void socket.sent.push(data),
    close: vi.fn(() => {
      socket.readyState = 2
    }),
  })
  return socket
}

function loggingRunner(history: SessionEventBody[]) {
  const listeners = new Set<(event: SessionEvent) => void>()
  const log: SessionEvent[] = history.map((body, index) => ({ ...body, seq: index + 1, ts: 0 }) as SessionEvent)
  const runner: Runner = {
    ...fakeRunner('s1', { cwd: '/tmp' }),
    subscribe: (listener, afterSeq = 0) => {
      for (const event of log) {
        if (event.seq > afterSeq) {
          listener(event)
        }
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const emit = (body: SessionEventBody): void => {
    const event = { ...body, seq: log.length + 1, ts: 0 } as SessionEvent
    log.push(event)
    for (const listener of listeners) {
      listener(event)
    }
  }
  return { runner, emit }
}

function context(): ServerContext {
  return {
    bridge: { attach: () => () => {} },
    parking: { onDetach: () => {} },
    projects: { withProject: <T>(info: T) => info },
    shells: null,
  } as unknown as ServerContext
}

const request = { url: '/v1/sessions/s1/ws' } as IncomingMessage

describe('session socket backpressure', () => {
  it('closes a live consumer whose outbound buffer passes the bound, with a code the client reconnects on', () => {
    const socket = fakeSocket()
    const { runner, emit } = loggingRunner([])
    attachClient(context(), socket as unknown as WebSocket, runner, request, { operator: true })
    emit({ type: 'status_changed', status: 'running' })
    expect(socket.close).not.toHaveBeenCalled()

    socket.bufferedAmount = SESSION_SOCKET_BUFFERED_MAX + 1
    const before = socket.sent.length
    emit({ type: 'status_changed', status: 'idle' })
    expect(socket.close).toHaveBeenCalledWith(SESSION_SOCKET_BACKPRESSURE_CODE, 'backpressure')
    expect(socket.sent).toHaveLength(before)
  })

  it('never refuses the replay, however much of it is still buffered', () => {
    const socket = fakeSocket()
    socket.bufferedAmount = SESSION_SOCKET_BUFFERED_MAX + 1
    const history: SessionEventBody[] = [
      { type: 'status_changed', status: 'running' },
      { type: 'status_changed', status: 'idle' },
    ]
    const { runner } = loggingRunner(history)
    attachClient(context(), socket as unknown as WebSocket, runner, request, { operator: true })
    expect(socket.close).not.toHaveBeenCalled()
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === 'event')).toHaveLength(2)
  })
})
