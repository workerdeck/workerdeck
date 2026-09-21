import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
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

async function startServer(peers?: { enabled?: boolean }) {
  const runners: ParkableRunner[] = []
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [providerProfile()],
    peers,
    createEngineRunner: ({ config, restore }) => {
      const runner = new ParkableRunner(`session-${runners.length + 1}`, config, restore)
      runners.push(runner)
      return runner
    },
  })
  const { base, wsBase } = await listenOn(running)
  return { base, wsBase, runners }
}

async function createSession(base: string, title: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi', meta: { title } }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

async function send(wsBase: string, sessionId: string, text: string) {
  const ws = new WebSocket(`${wsBase}/sessions/${sessionId}/ws`)
  const collector = frameCollector(ws)
  await collector.waitFor((f) => f.type === 'attached')
  ws.send(JSON.stringify({ type: 'user_message', text }))
  return { ws, collector }
}

describe('`#Name` over the wire', () => {
  it('reaches the runner as a resolved mention, with the text exactly as it was typed', async () => {
    const { base, wsBase, runners } = await startServer()
    await createSession(base, 'Astra')
    const mine = await createSession(base, 'Mine')
    const { ws } = await send(wsBase, mine.id, 'commit what #Astra did')
    const runner = runners.at(-1)!
    await vi.waitFor(() => expect(runner.sent).toHaveLength(1))
    expect(runner.sent[0]!.text).toBe('commit what #Astra did')
    expect(runner.sent[0]!.options?.mentions).toMatchObject([{ typed: 'Astra', name: 'Astra' }])
    ws.close()
  })

  it('never appends anything to a slash command, which the engine matches on the whole message', async () => {
    const { base, wsBase, runners } = await startServer()
    await createSession(base, 'Astra')
    const mine = await createSession(base, 'Mine')
    const { ws } = await send(wsBase, mine.id, '/clear #Astra')
    const runner = runners.at(-1)!
    await vi.waitFor(() => expect(runner.sent).toHaveLength(1))
    expect(runner.sent[0]!.options).toBeUndefined()
    ws.close()
  })

  it('delivers the message unchanged with peer messaging turned off', async () => {
    const { base, wsBase, runners } = await startServer({ enabled: false })
    await createSession(base, 'Astra')
    const mine = await createSession(base, 'Mine')
    const { ws } = await send(wsBase, mine.id, 'commit what #Astra did')
    const runner = runners.at(-1)!
    await vi.waitFor(() => expect(runner.sent).toHaveLength(1))
    expect(runner.sent[0]!.options).toBeUndefined()
    ws.close()
  })
})
