import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { EngineAdapter, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type ProfileInfo, type SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { ScriptedRunner } from './helpers.ts'

// Counts what the gateway asks of an engine that can report the account's windows. The reading only ever moved at a
// turn boundary before this, so an idle session served whatever it last heard, for days.
class UsageRunner extends ScriptedRunner {
  refreshes = 0

  constructor(id: string, config: SessionRunnerConfig) {
    super(id, config, { engine: 'claude', capabilities: ENGINE_CAPABILITIES.claude })
  }

  async refreshUsage(): Promise<void> {
    this.refreshes++
  }

  reportSevenDay(utilization: number, ts: number): void {
    this.emitAt({ type: 'rate_limit', info: { status: 'allowed', rateLimitType: 'seven_day', utilization } }, ts)
  }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

let configDir: string
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wd-usage-'))
})
afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

async function start(): Promise<{ base: string; runners: UsageRunner[]; port: number }> {
  const runners: UsageRunner[] = []
  const adapter: EngineAdapter = {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => {
      const runner = new UsageRunner(id ?? `session-${runners.length + 1}`, config)
      runners.push(runner)
      return runner
    },
  }
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [{ name: 'claude', engine: 'claude', configDir } satisfies ProfileInfo],
    engines: { claude: adapter },
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return { base: `http://127.0.0.1:${port}/v1`, runners, port }
}

async function createSession(base: string): Promise<string> {
  const created = (await (
    await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', profile: 'claude' }),
    })
  ).json()) as { session: SessionInfo }
  return created.session.id
}

describe('rate-limit freshness', () => {
  it('asks for a newer reading when a client attaches', async () => {
    const { base, runners, port } = await start()
    const id = await createSession(base)
    const runner = runners[0]!
    expect(runner.refreshes).toBe(0)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${id}/ws?afterSeq=0`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    // The attach replays whatever this session last heard, which on an idle session can be days old. Asking is the
    // only way a watched-but-not-driven session ever learns the number moved.
    expect(runner.refreshes).toBe(1)
    ws.close()
  })

  it('asks for a newer reading when a profiles read finds the held one stale', async () => {
    const { base, runners } = await start()
    await createSession(base)
    const runner = runners[0]!

    // The state a gateway sits in after a night of idle sessions: the held reading is the truth of two days ago,
    // and nothing in a profiles read used to ask for a newer one.
    runner.reportSevenDay(1, Date.now() - 2 * 24 * 60 * 60 * 1000)
    await fetch(`${base}/profiles`)
    expect(runner.refreshes).toBe(1)
  })

  it('leaves a fresh reading alone', async () => {
    const { base, runners } = await start()
    await createSession(base)
    const runner = runners[0]!

    runner.reportSevenDay(92, Date.now())
    await fetch(`${base}/profiles`)
    expect(runner.refreshes).toBe(0)
  })
})
