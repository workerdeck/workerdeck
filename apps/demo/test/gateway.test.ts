import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@workerdeck/protocol'

import { DemoGateway, DemoSocket } from '../src/stage/gateway.ts'
import { beat, say, status, turnEnd, user } from '../src/stage/tape.ts'

const SEED = { info: { id: 's1', cwd: '/tmp/p', title: 'One' }, history: beat(user('hello'), 1000, say('hi'), turnEnd()) }

function frames(socket: DemoSocket): ServerFrame[] {
  const out: ServerFrame[] = []
  vi.spyOn(socket, 'push').mockImplementation((frame) => {
    out.push(frame)
  })
  return out
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DemoGateway', () => {
  it('replays history on attach, then streams live cues', async () => {
    const gateway = new DemoGateway([SEED])
    const socket = new DemoSocket(gateway, 'ws://demo.invalid/v1/sessions/s1/ws?afterSeq=0')
    const received = frames(socket)
    await Promise.resolve()
    expect(received[0]).toMatchObject({ type: 'attached', session: { id: 's1', status: 'idle', lastSeq: 4 } })
    expect(received.slice(1).map((frame) => frame.type === 'event' && frame.event.seq)).toEqual([1, 2, 3, 4])
    gateway.apply('s1', status('running'))
    expect(received.at(-1)).toMatchObject({ type: 'event', event: { type: 'status_changed', seq: 5 } })
    expect(gateway.rows()[0]).toMatchObject({ state: 'working', info: { status: 'running' } })
  })

  it('honours beat gaps, scaled by speed', async () => {
    vi.useFakeTimers()
    const gateway = new DemoGateway([SEED], { speed: 2 })
    const done = gateway.play('s1', beat(status('running'), 1000, user('later')))
    expect(gateway.session('s1').status).toBe('running')
    expect(gateway.session('s1').lastSeq).toBe(5)
    await vi.advanceTimersByTimeAsync(499)
    expect(gateway.session('s1').lastSeq).toBe(5)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(gateway.session('s1').lastSeq).toBe(6)
  })

  it('routes client commands to the newest listener first', () => {
    const gateway = new DemoGateway([SEED])
    const socket = new DemoSocket(gateway, 'ws://demo.invalid/v1/sessions/s1/ws')
    const order: string[] = []
    gateway.onCommand(() => {
      order.push('default')
      return true
    })
    gateway.onCommand(() => {
      order.push('journey')
      return true
    })
    socket.send(JSON.stringify({ type: 'interrupt' }))
    expect(order).toEqual(['journey'])
  })

  it('counts unseen prose until the session is marked seen', () => {
    const gateway = new DemoGateway([SEED])
    gateway.apply('s1', say('news')[0]!)
    expect(gateway.rows()[0]!.unseen).toBe(1)
    gateway.markSeen('s1')
    expect(gateway.rows()[0]!.unseen).toBe(0)
  })
})
