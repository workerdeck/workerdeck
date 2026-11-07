import type { SessionInfo } from '@workerdeck/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { fakeHarness, frameCollector, listenOn } from './helpers.ts'

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('session socket compression', () => {
  it('negotiates permessage-deflate with a client that offers it', async () => {
    const harness = fakeHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { base, wsBase } = await listenOn(running)
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project' }),
    })
    const { session } = (await res.json()) as { session: SessionInfo }

    const ws = new WebSocket(`${wsBase}/sessions/${session.id}/ws`, { perMessageDeflate: true })
    const collector = frameCollector(ws)
    await collector.waitFor((f) => f.type === 'attached')
    expect(ws.extensions).toContain('permessage-deflate')
    ws.close()
  })
})
