import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentInput, EngineAdapter, Runner, SendMessageOptions, SessionRunnerConfig, SleepResult } from '@workerdeck/core'
import {
  ENGINE_CAPABILITIES,
  type GoalInput,
  type GoalSetter,
  type ProfileEngine,
  type ProfileInfo,
  type SessionEvent,
  type SessionGoal,
  type SessionInfo,
} from '@workerdeck/protocol'
import { createFileSessionRecordStore, createWorkerServer, type WorkerServer, type WorkerServerOptions } from '../src/index.ts'
import { EngineSleepTimers } from '../src/services/engine-sleep.ts'
import { EngineRunner } from './engine-runner.ts'
import { deferred, frameCollector, gatewayFixture, settled, until } from './helpers.ts'

const PROFILES: ProfileInfo[] = [
  { name: 'claude-a', engine: 'claude', configDir: '/tmp' },
  { name: 'codex-a', engine: 'codex' },
]

const fixture = gatewayFixture('wd-goals-')
afterEach(fixture.cleanup)

// Confirms each goal change the way the engines do: `goal_changed` first, then the promise. `hold` delays the next one.
class GoalEngine extends EngineRunner {
  readonly goalCalls: string[] = []
  readonly delivered: { text: string; options?: SendMessageOptions }[] = []
  confirmHold: Promise<void> | undefined
  refuse: string | undefined
  job = false
  #goal: SessionGoal | null | undefined

  constructor(
    id: string,
    config: SessionRunnerConfig,
    readonly engine: ProfileEngine,
  ) {
    super(id, config)
    this.#goal = config.goal
  }

  override info(): SessionInfo {
    const info = super.info()
    return {
      ...info,
      engine: this.engine,
      capabilities: { ...ENGINE_CAPABILITIES[this.engine], resume: true },
      ...(this.#goal ? { goal: this.#goal } : {}),
      ...(this.job ? { meta: { jobId: 'job-1' }, permissionMode: 'bypassPermissions' as const } : {}),
    }
  }

  override sendMessage(text: string, _attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    super.sendMessage(text)
    this.delivered.push({ text, ...(options ? { options } : {}) })
  }

  async setGoal(input: GoalInput, setBy: GoalSetter): Promise<SessionGoal> {
    this.goalCalls.push(`set:${input.text}:${setBy.kind}`)
    await this.#confirm()
    const goal: SessionGoal = {
      text: input.text,
      state: 'active',
      setAt: Date.now(),
      setBy,
      ...(typeof input.tokenBudget === 'number' ? { tokenBudget: input.tokenBudget } : {}),
    }
    this.#publish(goal, 'set')
    return goal
  }

  async clearGoal(): Promise<void> {
    this.goalCalls.push('clear')
    await this.#confirm()
    this.#publish(null, 'cleared')
  }

  async pauseGoal(paused: boolean): Promise<SessionGoal> {
    this.goalCalls.push(`pause:${paused}`)
    await this.#confirm()
    const goal = { ...this.#goal!, state: paused ? ('paused' as const) : ('active' as const) }
    this.#publish(goal, paused ? 'paused' : 'resumed')
    return goal
  }

  tick(tokensUsed: number): void {
    this.#publish({ ...this.#goal!, tokensUsed })
  }

  async #confirm(): Promise<void> {
    await this.confirmHold
    if (this.refuse) {
      throw new Error(this.refuse)
    }
  }

  #publish(goal: SessionGoal | null, notice?: 'set' | 'cleared' | 'paused' | 'resumed'): void {
    this.#goal = goal
    this.emit(notice ? { type: 'goal_changed', goal, notice } : { type: 'goal_changed', goal })
  }
}

type Hooks = { options?: Partial<WorkerServerOptions>; building?: (runner: GoalEngine) => void }

async function gateway(dir: string, hooks: Hooks = {}) {
  const built: GoalEngine[] = []
  const adapter = (engine: ProfileEngine): EngineAdapter => ({
    engine,
    capabilities: ENGINE_CAPABILITIES[engine],
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }: { config: SessionRunnerConfig; id?: string }) => {
      const runner = new GoalEngine(id ?? `${engine}${built.length + 1}-${dir.slice(-6)}`, config, engine)
      built.push(runner)
      hooks.building?.(runner)
      return runner
    },
  })
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: PROFILES,
    engines: { claude: adapter('claude'), codex: adapter('codex') },
    sessions: { store: createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
    parking: { parkDelayMs: 10 },
    historyReader: { read: async () => ({ kind: 'missing' }) },
    goalConfirmWaitMs: 2000,
    ...hooks.options,
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  const latest = (id: string): GoalEngine => server.registry.get(id) as GoalEngine
  return { server, built, latest, base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

type Call = { status: number; body: Record<string, any> }

async function call(base: string, path: string, method = 'GET', body?: unknown, generation?: number): Promise<Call> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(generation === undefined ? {} : { 'x-workerdeck-generation': String(generation) }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

async function create(base: string, profile: string): Promise<string> {
  const res = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile })
  expect(res.status).toBe(201)
  return (res.body.session as SessionInfo).id
}

async function agent(base: string, name: string, profile: string, lead?: string): Promise<string> {
  const res = await call(base, '/agents', 'POST', { name, config: { cwd: '/tmp', profile }, ...(lead ? { lead } : {}) })
  expect(res.status).toBe(201)
  return res.body.agent.id as string
}

function goalOf(server: WorkerServer, id: string): SessionGoal | undefined {
  return server.registry.get(id)?.info().goal
}

describe('goal routes', () => {
  it('sets, pauses, resumes and clears a codex goal as the human, answering the confirmed goal', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const id = await create(base, 'codex-a')
    await settled(server, id)

    const set = await call(base, `/sessions/${id}/goal`, 'POST', { text: ' ship the release ', tokenBudget: 5000 }, 1)
    expect(set.status).toBe(200)
    expect(set.body.goal).toMatchObject({ text: 'ship the release', state: 'active', tokenBudget: 5000, setBy: { kind: 'human' } })
    expect(set.body.session.goal).toMatchObject({ text: 'ship the release' })
    expect((await call(base, `/sessions/${id}/goal`)).body.goal).toMatchObject({ text: 'ship the release' })

    expect((await call(base, `/sessions/${id}/goal/pause`, 'POST', { paused: true }, 1)).body.goal).toMatchObject({ state: 'paused' })
    expect((await call(base, `/sessions/${id}/goal/pause`, 'POST', { paused: false }, 1)).body.goal).toMatchObject({ state: 'active' })
    const cleared = await call(base, `/sessions/${id}/goal`, 'DELETE', undefined, 1)
    expect(cleared.status).toBe(200)
    expect(cleared.body.goal).toBeNull()
    expect(latest(id).goalCalls).toEqual(['set:ship the release:human', 'pause:true', 'pause:false', 'clear'])
    expect((await call(base, `/sessions/${id}/goal/pause`)).status).toBe(405)
  })

  it('refuses input the engine cannot take, before the engine is asked', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const id = await create(base, 'claude-a')
    await settled(server, id)
    const refused = async (path: string, body: unknown): Promise<string> => {
      const res = await call(base, `/sessions/${id}${path}`, 'POST', body, 1)
      expect(res.status).toBe(400)
      return res.body.error as string
    }
    expect(await refused('/goal', { text: 'x', tokenBudget: 10 })).toMatch(/token budgets/)
    expect(await refused('/goal', { text: '  ' })).toMatch(/must not be empty/)
    expect(await refused('/goal', { text: 'Clear' })).toMatch(/clear command/)
    expect(await refused('/goal', { text: 'x'.repeat(4001) })).toMatch(/longer than 4000/)
    expect(await refused('/goal/pause', { paused: true })).toMatch(/cannot pause/)
    expect(latest(id).goalCalls).toEqual([])
    expect((await call(base, `/sessions/${id}/goal`, 'POST', { text: 'tests pass' }, 1)).status).toBe(200)
  })

  it('refuses a call that names no conversation or a past one, and lands one naming the current one after a cut', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const id = await create(base, 'codex-a')
    await settled(server, id)
    expect((await call(base, `/sessions/${id}/goal`, 'POST', { text: 'a' })).status).toBe(409)
    expect(goalOf(server, id)).toBeUndefined()

    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(200)
    await settled(server, id)
    const stale = await call(base, `/sessions/${id}/goal`, 'POST', { text: 'b' }, 1)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/conversation 2/)
    expect(latest(id).goalCalls).toEqual([])
    expect((await call(base, `/sessions/${id}/goal`, 'POST', { text: 'b' }, 2)).body.goal).toMatchObject({ text: 'b' })
  })

  it('refuses a goal change while a cut is running, and starts nothing on either conversation', async () => {
    const dir = await fixture.stateDir()
    const held = deferred()
    let builds = 0
    const { server, base, built } = await gateway(dir, {
      building: (runner) => {
        if (++builds === 2) {
          runner.hold = held.promise
        }
      },
    })
    const id = await create(base, 'codex-a')
    await settled(server, id)
    const cutting = call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    await until(() => server.locks.gated(id), 'the cut gate')
    const refused = await call(base, `/sessions/${id}/goal`, 'POST', { text: 'mid-cut' }, 1)
    expect(refused.status).toBe(409)
    held.resolve()
    expect((await cutting).status).toBe(200)
    expect(built.flatMap((runner) => runner.goalCalls)).toEqual([])
  })

  it('answers 202 with the goal as it stands while the engine has not confirmed yet', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir, { options: { goalConfirmWaitMs: 30 } })
    const id = await create(base, 'claude-a')
    await settled(server, id)
    const confirm = deferred()
    latest(id).confirmHold = confirm.promise
    const pending = await call(base, `/sessions/${id}/goal`, 'POST', { text: 'after the turn' }, 1)
    expect(pending.status).toBe(202)
    expect(pending.body).toMatchObject({ pending: true, goal: null })
    confirm.resolve()
    await until(() => goalOf(server, id)?.text === 'after the turn', 'the goal to land')
  })

  it("refuses a job run's goal in bypass under disableBypassPermissions: 'sessions'", async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir, {
      options: { disableBypassPermissions: 'sessions' },
      building: (runner) => {
        runner.job = true
      },
    })
    const id = await create(base, 'codex-a')
    await settled(server, id)
    const res = await call(base, `/sessions/${id}/goal`, 'POST', { text: 'x' }, 1)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/bypassPermissions/)
    expect(latest(id).goalCalls).toEqual([])
  })
})

describe('goal socket commands', () => {
  it('runs set, pause and clear frames naming the socket conversation, and refuses a frame naming another', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, latest } = await gateway(dir)
    const id = await create(base, 'codex-a')
    await settled(server, id)
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const frames = frameCollector(ws)
    await frames.waitFor((frame) => frame.type === 'attached')
    const send = (frame: Record<string, unknown>) => ws.send(JSON.stringify(frame))

    send({ generation: 2, type: 'set_goal', text: 'wrong conversation' })
    await frames.waitFor((frame) => frame.type === 'protocol_error')
    send({ type: 'clear_goal' })
    await until(() => frames.frames.filter((frame) => frame.type === 'protocol_error').length === 2, 'the untokened refusal')
    send({ generation: 1, type: 'set_goal', text: 'green CI', tokenBudget: 100 })
    await frames.waitFor((frame) => frame.type === 'event' && (frame.event as SessionEvent).type === 'goal_changed')
    send({ generation: 1, type: 'pause_goal', paused: true })
    await until(() => goalOf(server, id)?.state === 'paused', 'the pause')
    send({ generation: 1, type: 'clear_goal' })
    await until(() => latest(id).goalCalls.includes('clear'), 'the clear')
    send({ generation: 1, type: 'pause_goal', paused: 'yes' })
    await until(() => frames.frames.filter((frame) => frame.type === 'protocol_error').length === 3, 'the malformed pause')
    expect(latest(id).goalCalls).toEqual(['set:green CI:human', 'pause:true', 'clear'])
    ws.close()
  })
})

describe('goal tools', () => {
  it('lets a session manage its own goal and a lead its members, stamping the agent that set it', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const lead = await agent(base, 'Atlas', 'codex-a')
    const member = await agent(base, 'Pip', 'claude-a', lead)
    const outsider = await agent(base, 'Quill', 'codex-a')
    await settled(server, lead)
    await settled(server, member)
    const tools = latest(lead).config.goals!
    expect(latest(member).config.goals).toBeDefined()

    expect(await tools.get(lead, {})).toBe('No goal on your session.')
    expect(await tools.set(lead, { text: 'ship 4.4' })).toMatch(/^Goal set on your session: ship 4.4 \[active, set by Atlas\]/)
    expect(await tools.set(lead, { text: 'docs updated', target: 'pip' })).toMatch(/^Goal set on Pip: docs updated/)
    expect(goalOf(server, member)).toMatchObject({ setBy: { kind: 'agent', sessionId: lead, name: 'Atlas' } })
    expect(await tools.get(lead, { target: member })).toMatch(/^Goal on Pip: docs updated/)
    expect(await tools.clear(lead, { target: 'Pip' })).toBe('Goal cleared on Pip.')

    await expect(tools.set(lead, { text: 'x', target: 'Quill' })).rejects.toThrow(/not a member of a team you lead/)
    await expect(tools.get(member, { target: 'Atlas' })).rejects.toThrow(/not a member of a team you lead/)
    await expect(tools.set(outsider, { text: 'x', target: member })).rejects.toThrow(/not a member/)
    await expect(tools.pause(member, { paused: true })).rejects.toThrow(/cannot pause/)
    expect(latest(outsider).goalCalls).toEqual([])
  })

  it('never lets an agent replace, clear or pause a goal the human set', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const lead = await agent(base, 'Atlas', 'codex-a')
    const member = await agent(base, 'Pip', 'codex-a', lead)
    await settled(server, member)
    expect((await call(base, `/sessions/${member}/goal`, 'POST', { text: 'human goal' }, 1)).status).toBe(200)
    const tools = latest(lead).config.goals!
    await expect(tools.set(lead, { text: 'mine now', target: 'Pip' })).rejects.toThrow(
      'the human set this goal; an agent cannot replace it',
    )
    await expect(tools.clear(lead, { target: 'Pip' })).rejects.toThrow(/cannot clear it/)
    await expect(tools.pause(member, { paused: true })).rejects.toThrow(/cannot pause it/)
    expect(latest(member).goalCalls).toEqual(['set:human goal:human'])
    expect((await call(base, `/sessions/${member}/goal`, 'DELETE', undefined, 1)).status).toBe(200)
    expect(await tools.set(lead, { text: 'mine now', target: 'Pip' })).toMatch(/^Goal set on Pip/)
    expect((await call(base, `/sessions/${member}/goal`, 'POST', { text: 'human again' }, 1)).body.goal).toMatchObject({
      setBy: { kind: 'human' },
    })
  })

  it("answers 'requested' when its own engine applies the goal only after the running turn", async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir, { options: { goalConfirmWaitMs: 30 } })
    const id = await create(base, 'claude-a')
    await settled(server, id)
    latest(id).confirmHold = new Promise(() => {})
    expect(await latest(id).config.goals!.set(id, { text: 'later' })).toBe(
      'Goal change requested; it takes effect when your current turn ends.',
    )
  })

  it("reports the engine's refusal to the model", async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const id = await create(base, 'codex-a')
    await settled(server, id)
    latest(id).refuse = 'goals are disabled'
    await expect(latest(id).config.goals!.set(id, { text: 'x' })).rejects.toThrow('goals are disabled')
  })
})

describe('goal persistence', () => {
  it('keeps the goal on the dormant record, wakes with it, and keeps a clear as a null tombstone', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base, 'codex-a')
    await settled(first.server, id)
    await call(first.base, `/sessions/${id}/goal`, 'POST', { text: 'survive restarts' }, 1)
    first.latest(id).tick(10)
    const recordFile = join(dir, 'sessions', `${id}.json`)
    await until(async () => (await readFile(recordFile, 'utf8').catch(() => '')).includes('survive restarts'), 'the goal on the record')
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)
    await first.server.close()

    const second = await gateway(dir)
    const listed = (await call(second.base, '/sessions')).body.sessions as SessionInfo[]
    expect(listed.find((session) => session.id === id)?.goal).toMatchObject({ text: 'survive restarts', state: 'active' })
    const cleared = await call(second.base, `/sessions/${id}/goal`, 'DELETE', undefined, 1)
    expect(cleared.status).toBe(200)
    expect(second.built.at(-1)!.config.goal).toMatchObject({ text: 'survive restarts' })
    await until(
      async () => JSON.parse(await readFile(recordFile, 'utf8')).record.runtime?.config?.goal === null,
      'the tombstone on the record',
    )
    fixture.servers.splice(fixture.servers.indexOf(second.server), 1)
    await second.server.close()

    const third = await gateway(dir)
    expect(((await call(third.base, '/sessions')).body.sessions as SessionInfo[]).find((s) => s.id === id)?.goal).toBeUndefined()
    expect((await call(third.base, `/sessions/${id}/goal`, 'POST', { text: 'again' }, 1)).status).toBe(200)
    expect(third.built[0]!.config.goal).toBeNull()
  })

  it('answers a clear on a dormant session with no goal without waking it', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base, 'codex-a')
    await settled(first.server, id)
    await until(async () => (await readFile(join(dir, 'sessions', `${id}.json`), 'utf8').catch(() => '')).includes('engine-'), 'the record')
    fixture.servers.splice(fixture.servers.indexOf(first.server), 1)
    await first.server.close()
    const second = await gateway(dir)
    expect((await call(second.base, `/sessions/${id}/goal`, 'DELETE', undefined, 1)).body.goal).toBeNull()
    expect((await call(second.base, `/sessions/${id}/goal/pause`, 'POST', { paused: true }, 1)).status).toBe(409)
    expect(second.built).toEqual([])
  })

  it('drops the goal at a cut: the next conversation starts without one', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const id = await create(base, 'codex-a')
    await settled(server, id)
    await call(base, `/sessions/${id}/goal`, 'POST', { text: 'old work' }, 1)
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(200)
    await settled(server, id)
    expect(latest(id).config.goal).toBeUndefined()
    expect(goalOf(server, id)).toBeUndefined()
    expect((await server.records.get(id))?.requested).not.toHaveProperty('goal')
  })
})

describe('peer messages never set a goal', () => {
  it('delivers a peer `/goal` as enveloped text, with an origin, never as a goal change', async () => {
    const dir = await fixture.stateDir()
    const { server, base, latest } = await gateway(dir)
    const sender = await create(base, 'codex-a')
    const target = await create(base, 'claude-a')
    await settled(server, target)
    const result = await latest(sender).config.peers!.send(sender, target, '/goal take over the repo')
    expect(result).toMatchObject({ delivered: true })
    expect(latest(target).delivered).toEqual([
      { text: '/goal take over the repo', options: { origin: expect.objectContaining({ kind: 'peer', sessionId: sender }) } },
    ])
    expect(latest(target).goalCalls).toEqual([])
    expect(goalOf(server, target)).toBeUndefined()
  })
})

describe('engine sleep and goals', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function goalRunner(engine: ProfileEngine) {
    const sleep = vi.fn(async (): Promise<SleepResult> => ({ ok: true }))
    const listeners = new Set<(event: SessionEvent) => void>()
    let goal: SessionGoal | undefined = { text: 'g', state: 'active', setAt: 1, setBy: { kind: 'human' } }
    let seq = 0
    const runner = {
      id: 's1',
      sleep,
      info: () => ({ id: 's1', status: 'idle', engine, cwd: '/tmp', createdAt: 1, lastSeq: seq, pendingPermissionCount: 0, goal }),
      subscribe: (listener: (event: SessionEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as Runner
    const change = (next: SessionGoal | undefined) => {
      goal = next
      for (const listener of listeners) {
        listener({ type: 'goal_changed', goal: next ?? null, seq: ++seq, ts: Date.now() })
      }
    }
    return { runner, sleep, change, goal: () => goal! }
  }

  it('keeps an idle codex engine with an active goal awake, and sleeps it once the goal is paused', async () => {
    vi.useFakeTimers()
    const timers = new EngineSleepTimers({ afterMs: 1000, attachedCount: () => 0 })
    const codex = goalRunner('codex')
    timers.watch(codex.runner)
    await vi.advanceTimersByTimeAsync(5000)
    expect(codex.sleep).not.toHaveBeenCalled()
    codex.change({ ...codex.goal(), state: 'paused' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(codex.sleep).toHaveBeenCalledTimes(1)
    timers.close()
  })

  it('sleeps an idle claude engine whatever its goal, since claude never starts a goal turn by itself', async () => {
    vi.useFakeTimers()
    const timers = new EngineSleepTimers({ afterMs: 1000, attachedCount: () => 0 })
    const claude = goalRunner('claude')
    timers.watch(claude.runner)
    await vi.advanceTimersByTimeAsync(1000)
    expect(claude.sleep).toHaveBeenCalledTimes(1)
    timers.close()
  })
})
