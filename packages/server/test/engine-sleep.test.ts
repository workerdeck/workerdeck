import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Runner, SleepResult } from '@workerdeck/core'
import type { SessionEvent, SessionInfo, SessionStatus } from '@workerdeck/protocol'
import { EngineSleepTimers } from '../src/services/engine-sleep.ts'
import { fakeHarness, fakeRunner } from './helpers.ts'
import { attachSocket, createSession, get, shellFixture } from './shell-helpers.ts'

const fx = shellFixture('wd-engine-sleep-')
afterEach(fx.cleanup)

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp',
  tools: [],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  uuid: 'u-init',
} as unknown as SDKMessage

const RESULT = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'ok',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: 'u-r',
  session_id: 'sdk-1',
} as unknown as SDKMessage

function post(base: string, path: string) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer operator' } })
}

async function info(base: string, id: string): Promise<SessionInfo> {
  return ((await (await get(base, `/sessions/${id}`)).json()) as { session: SessionInfo }).session
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never held')
}

describe('POST /sessions/:id/sleep', () => {
  it('refuses a session that has not started a conversation, then sleeps an idle one', async () => {
    const harness = fakeHarness()
    const { base } = await fx.startServer(harness)
    const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
    await waitFor(async () => (await info(base, id)).status === 'idle')

    const refused = await post(base, `/sessions/${id}/sleep`)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toMatch(/not started a conversation/)

    harness.emit(INIT)
    harness.emit(RESULT)
    await waitFor(async () => (await info(base, id)).sdkSessionId === 'sdk-1' && (await info(base, id)).status === 'idle')
    const slept = await post(base, `/sessions/${id}/sleep`)
    expect(slept.status).toBe(200)
    expect(((await slept.json()) as { session: SessionInfo }).session.engineAsleep).toBe(true)
    expect((await info(base, id)).engineAsleep).toBe(true)
    expect((await get(base, `/sessions/${id}/sleep`)).status).toBe(405)
  })

  it('accepts a sleep frame over the socket', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await fx.startServer(harness)
    const id = await createSession(base, 'operator', { cwd: fx.tempDir() })
    harness.emit(INIT)
    harness.emit(RESULT)
    await waitFor(async () => (await info(base, id)).sdkSessionId === 'sdk-1' && (await info(base, id)).status === 'idle')
    const { ws, collector } = await attachSocket(wsBase, id, 'operator')
    ws.send(JSON.stringify({ type: 'sleep' }))
    await collector.waitFor((frame) => frame.type === 'event' && frame.event.type === 'engine_sleep' && frame.event.asleep)
    ws.close()
  })
})

class SleepyRunner {
  status: SessionStatus = 'idle'
  asleep = false
  readonly sleep = vi.fn(async (): Promise<SleepResult> => {
    this.asleep = true
    return { ok: true }
  })
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0
  readonly runner: Runner

  constructor(id: string) {
    const base = fakeRunner(id, { cwd: '/tmp' })
    this.runner = {
      ...base,
      sleep: this.sleep,
      info: () => ({ ...base.info(), status: this.status, engineAsleep: this.asleep ? true : undefined }),
      subscribe: (listener) => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
      },
    }
  }

  setStatus(status: SessionStatus): void {
    this.status = status
    for (const listener of this.#listeners) {
      listener({ type: 'status_changed', status, seq: ++this.#seq, ts: Date.now() })
    }
  }
}

describe('EngineSleepTimers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sleeps an idle, unwatched session after the timeout and re-arms on every idle', async () => {
    vi.useFakeTimers()
    const attached = new Map<string, number>()
    const timers = new EngineSleepTimers({ afterMs: 1000, attachedCount: (id) => attached.get(id) ?? 0 })
    const sleepy = new SleepyRunner('s1')
    const detach = timers.watch(sleepy.runner)
    await vi.advanceTimersByTimeAsync(999)
    expect(sleepy.sleep).not.toHaveBeenCalled()
    sleepy.setStatus('running')
    await vi.advanceTimersByTimeAsync(2000)
    expect(sleepy.sleep).not.toHaveBeenCalled()
    sleepy.setStatus('idle')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sleepy.sleep).toHaveBeenCalledTimes(1)
    detach?.()
    timers.close()
  })

  it('leaves a watched session awake until its last client leaves', async () => {
    vi.useFakeTimers()
    const attached = new Map<string, number>([['s1', 1]])
    const timers = new EngineSleepTimers({ afterMs: 1000, attachedCount: (id) => attached.get(id) ?? 0 })
    const sleepy = new SleepyRunner('s1')
    timers.watch(sleepy.runner)
    await vi.advanceTimersByTimeAsync(5000)
    expect(sleepy.sleep).not.toHaveBeenCalled()
    attached.set('s1', 0)
    timers.onDetach('s1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sleepy.sleep).toHaveBeenCalledTimes(1)
    timers.onDetach('s1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sleepy.sleep).toHaveBeenCalledTimes(1)
    timers.close()
  })

  it("takes a per-session timeout over the gateway's, so an agent sleeps on a gateway that has sleep off", async () => {
    vi.useFakeTimers()
    const timers = new EngineSleepTimers({ afterMs: 0, afterMsFor: (id) => (id === 'agent' ? 500 : undefined), attachedCount: () => 0 })
    const agent = new SleepyRunner('agent')
    const plain = new SleepyRunner('plain')
    timers.watch(agent.runner)
    timers.watch(plain.runner)
    await vi.advanceTimersByTimeAsync(500)
    expect(agent.sleep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(plain.sleep).not.toHaveBeenCalled()
    timers.close()
  })

  it('does nothing at 0 and stops when closed', async () => {
    vi.useFakeTimers()
    const off = new EngineSleepTimers({ afterMs: 0, attachedCount: () => 0 })
    const a = new SleepyRunner('a')
    expect(off.watch(a.runner)).toBeUndefined()
    const on = new EngineSleepTimers({ afterMs: 1000, attachedCount: () => 0 })
    const b = new SleepyRunner('b')
    on.watch(b.runner)
    on.close()
    await vi.advanceTimersByTimeAsync(5000)
    expect(a.sleep).not.toHaveBeenCalled()
    expect(b.sleep).not.toHaveBeenCalled()
  })
})
