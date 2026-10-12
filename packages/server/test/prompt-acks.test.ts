import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { PromptAcks } from '../src/services/prompt-acks.ts'
import { ParkableRunner } from './parkable-runner.ts'
import { frameCollector, listenOn } from './helpers.ts'

function providerProfile(): ProfileInfo {
  return { name: 'kimi', engine: 'provider', provider: { id: 'moonshotai', model: 'kimi-k3' } }
}

let running: WorkerServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start() {
  const runners: ParkableRunner[] = []
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [providerProfile()],
    createEngineRunner: ({ config, restore }) => {
      const runner = new ParkableRunner(`session-${runners.length + 1}`, config, restore)
      runners.push(runner)
      return runner
    },
  })
  const { base, wsBase } = await listenOn(running)
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi', meta: { title: 'Mine' } }),
  })
  const session = ((await res.json()) as { session: SessionInfo }).session
  return { wsBase, session, runner: runners.at(-1)! }
}

async function attach(wsBase: string, sessionId: string) {
  const ws = new WebSocket(`${wsBase}/sessions/${sessionId}/ws`)
  const collector = frameCollector(ws)
  const attached = await collector.waitFor((f) => f.type === 'attached')
  return { ws, collector, attached }
}

describe('prompt acks', () => {
  it('advertises acks and answers a prompt with its clientId', async () => {
    const { wsBase, session, runner } = await start()
    const { ws, collector, attached } = await attach(wsBase, session.id)
    expect(attached).toMatchObject({ acks: true })
    ws.send(JSON.stringify({ type: 'user_message', text: 'hello', clientId: 'c.1' }))
    await collector.waitFor((f) => f.type === 'ack' && f.clientId === 'c.1')
    expect(runner.sent.map((sent) => sent.text)).toEqual(['hello'])
    ws.close()
  })

  it('runs a prompt resent on a new socket once, and acks both', async () => {
    const { wsBase, session, runner } = await start()
    const first = await attach(wsBase, session.id)
    first.ws.send(JSON.stringify({ type: 'user_message', text: 'once', clientId: 'c.1' }))
    await first.collector.waitFor((f) => f.type === 'ack')
    first.ws.close()
    const second = await attach(wsBase, session.id)
    second.ws.send(JSON.stringify({ type: 'user_message', text: 'once', clientId: 'c.1' }))
    second.ws.send(JSON.stringify({ type: 'user_message', text: 'next', clientId: 'c.2' }))
    await second.collector.waitFor((f) => f.type === 'ack' && f.clientId === 'c.2')
    expect(runner.sent.map((sent) => sent.text)).toEqual(['once', 'next'])
    second.ws.close()
  })

  it('acks a refused prompt after its protocol error', async () => {
    const { wsBase, session } = await start()
    const { ws, collector } = await attach(wsBase, session.id)
    ws.send(JSON.stringify({ type: 'user_message', text: 'x', attachmentIds: ['missing'], clientId: 'c.9' }))
    await collector.waitFor((f) => f.type === 'ack')
    const kinds = collector.frames.filter((f) => f.type === 'protocol_error' || f.type === 'ack').map((f) => f.type)
    expect(kinds).toEqual(['protocol_error', 'ack'])
    ws.close()
  })

  it('keeps prompts in arrival order and sends no ack without a clientId', async () => {
    const { wsBase, session, runner } = await start()
    const { ws, collector } = await attach(wsBase, session.id)
    for (const text of ['a', 'b', 'c']) {
      ws.send(JSON.stringify({ type: 'user_message', text }))
    }
    await vi.waitFor(() => expect(runner.sent.map((sent) => sent.text)).toEqual(['a', 'b', 'c']))
    expect(collector.frames.some((f) => f.type === 'ack')).toBe(false)
    ws.close()
  })
})

describe('PromptAcks', () => {
  it('forgets the oldest id past its bound and a failed run', async () => {
    const acks = new PromptAcks(2)
    let runs = 0
    const handle = async () => {
      runs++
    }
    await acks.run('s', 'a', handle)
    await acks.run('s', 'b', handle)
    await acks.run('s', 'c', handle)
    await acks.run('s', 'a', handle)
    expect(runs).toBe(4)
    await acks.run('s', 'c', handle)
    expect(runs).toBe(4)
    await expect(acks.run('s', 'f', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    await acks.run('s', 'f', handle)
    expect(runs).toBe(5)
  })
})
