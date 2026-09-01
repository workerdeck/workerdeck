import { afterEach, describe, expect, it } from 'vitest'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo, SessionStatus } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { fakeRunner, listenOn } from './helpers.ts'

/** A runner whose reported status the test drives, so a drain can be watched converging. */
function steerableRunner(id: string, config: SessionRunnerConfig, status: SessionStatus) {
  const inner = fakeRunner(id, config)
  let current = status
  const runner: Runner = {
    ...inner,
    info: (): SessionInfo => ({
      ...inner.info(),
      id,
      status: current,
      pendingPermissionCount: current === 'awaiting_approval' ? 1 : 0,
    }),
  }
  return {
    runner,
    finish: () => {
      current = 'idle'
    },
  }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function startWith(status: SessionStatus) {
  running = createWorkerServer({ allowUnauthenticated: true, allowedCwdRoots: ['/tmp'] })
  const { base } = await listenOn(running)
  // Registered straight on the registry: the drain reads `registry.list()`, and this lets the test drive the one
  // thing it cares about — the reported status — without standing up a real engine.
  const steer = steerableRunner('s-1', { cwd: '/tmp/project' } as SessionRunnerConfig, status)
  running.registry.register(steer.runner)
  return { base, steer, server: running }
}

describe('drain', () => {
  it('returns immediately when nothing is running', async () => {
    const { server } = await startWith('idle')
    const report = await server.drain({ timeoutMs: 2_000, pollMs: 10 })
    expect(report).toEqual({ working: [], awaitingHuman: [], timedOut: false })
  })

  it('waits for a running turn and reports when it finishes', async () => {
    const { server, steer } = await startWith('running')
    const seen: string[][] = []
    setTimeout(() => steer.finish(), 60)
    const report = await server.drain({
      timeoutMs: 5_000,
      pollMs: 10,
      onProgress: (r) => seen.push(r.working),
    })
    expect(report.working).toEqual([])
    expect(report.timedOut).toBe(false)
    expect(seen[0]).toEqual(['s-1'])
  })

  // The decision that makes or breaks the feature: a session blocked on a human will never resolve on its own, so
  // waiting for it is a hang with better manners. It is named in the report and left behind.
  it('never waits on a session that is blocked on an approval', async () => {
    const { server } = await startWith('awaiting_approval')
    const report = await server.drain({ timeoutMs: 5_000, pollMs: 10 })
    expect(report.awaitingHuman).toEqual(['s-1'])
    expect(report.working).toEqual([])
    expect(report.timedOut).toBe(false)
  })

  it('gives up at the deadline rather than blocking shutdown forever', async () => {
    const { server } = await startWith('running')
    const report = await server.drain({ timeoutMs: 60, pollMs: 10 })
    expect(report.working).toEqual(['s-1'])
    expect(report.timedOut).toBe(true)
  })

  it('refuses new sessions once draining, but leaves existing ones controllable', async () => {
    const { base, server, steer } = await startWith('running')
    setTimeout(() => steer.finish(), 300)
    const draining = server.drain({ timeoutMs: 5_000, pollMs: 10 })

    const rejected = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project' }),
    })
    expect(rejected.status).toBe(503)
    // Reading and steering an existing session must keep working — that is how an operator clears an approval.
    expect((await fetch(`${base}/sessions/s-1`)).status).toBe(200)
    await draining
  })
})
