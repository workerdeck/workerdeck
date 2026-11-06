import { describe, expect, it } from 'vitest'
import type { GoalSetter, SessionEvent, SessionGoal } from '@workerdeck/protocol'
import { CodexRunner, type CodexRunnerConfig } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import type { AppServerThreadGoal } from '../src/engines/codex/types.ts'
import { collect, ofType, scriptTurn, scriptedPeer, type ScriptedPeer } from './helpers/codex-peer.ts'
import { fixtureGoals, goalFixture, playFixture } from './helpers/codex-goal-fixture.ts'
import { eventually } from './helpers/wait.ts'

const HUMAN: GoalSetter = { kind: 'human' }
const LEAD: GoalSetter = { kind: 'agent', sessionId: 'lead-1', name: 'Lead' }

function threadGoal(overrides: Partial<AppServerThreadGoal> = {}): AppServerThreadGoal {
  return {
    threadId: 'thread-1',
    objective: 'ship it',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    ...overrides,
  }
}

function storedGoal(goal: AppServerThreadGoal, setBy: GoalSetter, state: SessionGoal['state'] = 'active'): SessionGoal {
  return {
    text: goal.objective,
    state,
    setAt: goal.createdAt * 1000,
    setBy,
    tokensUsed: goal.tokensUsed,
    ...(goal.tokenBudget ? { tokenBudget: goal.tokenBudget } : {}),
    timeUsedSeconds: goal.timeUsedSeconds,
  }
}

function updated(goal: AppServerThreadGoal, turnId: string | null = null) {
  return { threadId: goal.threadId, turnId, goal }
}

function goalEvents(events: SessionEvent[]) {
  return ofType(events, 'goal_changed')
}

function notices(events: SessionEvent[]) {
  return goalEvents(events).flatMap((event) => (event.notice ? [event.notice] : []))
}

function requests(peer: ScriptedPeer, method: string) {
  return peer.requests.filter((request) => request.method === method)
}

async function freshRunner(peer: ScriptedPeer, config: Partial<CodexRunnerConfig> = {}) {
  const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn, ...config })
  const events = collect(runner)
  await runner.start()
  return { runner, events }
}

async function liveIdleRunner(peer: ScriptedPeer, config: Partial<CodexRunnerConfig> = {}) {
  scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }), 'turn-0')
  const started = await freshRunner(peer, { prompt: 'set things up', ...config })
  expect(ofType(started.events, 'turn_result')).toHaveLength(1)
  return started
}

function dormant(peer: ScriptedPeer, goal: SessionGoal | null | undefined, config: Partial<CodexRunnerConfig> = {}) {
  return freshRunner(peer, { resume: 'thread-1', ...(goal !== undefined ? { goal } : {}), ...config })
}

describe('CodexRunner goals: recorded codex 0.166.0 sessions', () => {
  it('set on an idle thread: one set notice, the engine-started turn is owned, ticks carry no notice, met, cleared', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('complete')
    const play = playFixture(peer, lines)
    const { runner, events } = await freshRunner(peer)

    const goal = await runner.setGoal({ text: fixtureGoals(lines)[0]!.objective }, HUMAN)
    expect(goal).toMatchObject({ state: 'active', setBy: HUMAN, tokensUsed: 0, setAt: fixtureGoals(lines)[0]!.createdAt * 1000 })
    expect(goal.tokenBudget).toBeUndefined()
    expect(requests(peer, 'thread/goal/set')[0]!.params).toEqual({
      threadId: 'thread-1',
      objective: goal.text,
      status: 'active',
      origin: 'user',
    })
    expect(notices(events)).toEqual(['set'])

    play.notes()
    await eventually(() => expect(runner.status).toBe('idle'))
    expect(requests(peer, 'turn/start')).toHaveLength(0)
    expect(ofType(events, 'turn_result')).toEqual([
      expect.objectContaining({ subtype: 'success', result: expect.stringContaining('done.txt') }),
    ])
    expect(notices(events)).toEqual(['set', 'met'])
    expect(goalEvents(events).filter((event) => !event.notice).length).toBeGreaterThan(0)
    expect(runner.info().goal).toMatchObject({ state: 'met', tokensUsed: 15553, setBy: HUMAN })

    await runner.clearGoal()
    expect(notices(events)).toEqual(['set', 'met', 'cleared'])
    expect(runner.info().goal).toBeUndefined()
    expect(play.done()).toBe(true)
  })

  it('budget exhaustion: limited with limit budget, and the running turn keeps running', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('budget')
    const play = playFixture(peer, lines)
    const { runner, events } = await freshRunner(peer)

    const goal = await runner.setGoal({ text: fixtureGoals(lines)[0]!.objective, tokenBudget: 15000 }, LEAD)
    expect(goal).toMatchObject({ tokenBudget: 15000, setBy: LEAD })
    expect(requests(peer, 'thread/goal/set')[0]!.params).toMatchObject({ tokenBudget: 15000 })
    expect(goalEvents(events)).toHaveLength(1)

    play.notes()
    expect(runner.status).toBe('running')
    expect(runner.info().goal).toMatchObject({ state: 'limited', limit: 'budget', tokensUsed: 15846, tokenBudget: 15000, setBy: LEAD })
    expect(notices(events)).toEqual(['set', 'limited'])
    expect(ofType(events, 'turn_result')).toHaveLength(0)

    await runner.clearGoal()
    expect(runner.info().goal).toBeUndefined()
    expect(notices(events)).toEqual(['set', 'limited', 'cleared'])
  })

  it('pause mid turn: one paused notice although a tick and the update overtake the response; the turn finishes', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('pause')
    const play = playFixture(peer, lines)
    const { runner, events } = await freshRunner(peer)

    await runner.setGoal({ text: fixtureGoals(lines)[0]!.objective, tokenBudget: 60000 }, HUMAN)
    play.notes()
    expect(runner.status).toBe('running')

    const paused = await runner.pauseGoal(true)
    expect(paused).toMatchObject({ state: 'paused', setBy: HUMAN })
    expect(requests(peer, 'thread/goal/set')[1]!.params).toEqual({ threadId: 'thread-1', status: 'paused', origin: 'user' })
    expect(notices(events)).toEqual(['set', 'paused'])
    expect(runner.status).toBe('running')

    play.notes()
    await eventually(() => expect(runner.status).toBe('idle'))
    expect(ofType(events, 'turn_result')).toHaveLength(1)
    expect(play.done()).toBe(true)
  })

  it('resume a paused goal on a dormant runner: wakes the engine, the resume starts nothing, the continuation is owned', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('resume-paused')
    const play = playFixture(peer, lines)
    const known = storedGoal(fixtureGoals(lines)[0]!, HUMAN, 'paused')
    const { runner, events } = await dormant(peer, known, { backfillHistory: false, startAsleep: true })
    expect(runner.engineAsleep).toBe(true)
    expect(runner.info().goal).toEqual(known)

    const resumed = await runner.pauseGoal(false)
    expect(runner.engineAsleep).toBe(false)
    expect(peer.requests.map((r) => r.method).filter((m) => m.startsWith('thread/'))).toEqual([
      'thread/resume',
      'thread/goal/get',
      'thread/goal/set',
    ])
    expect(resumed).toMatchObject({ state: 'active', setBy: HUMAN })
    expect(notices(events)).toEqual(['resumed'])

    play.notes()
    expect(runner.status).toBe('running')
    expect(requests(peer, 'turn/start')).toHaveLength(0)
    expect(play.done()).toBe(true)
  })

  it('explicit wake with an active goal: the restarted turn is the one the send joins; Stop interrupts and pauses', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('wake-active')
    const goals = fixtureGoals(lines)
    const play = playFixture(peer, lines, {
      'turn/start': () => {
        play.notes()
        return { turn: { id: 'turn-3', status: 'inProgress' } }
      },
      'thread/goal/set': () => ({ goal: { ...goals.at(-1)!, status: 'paused' } }),
    })
    const known = storedGoal(goals[0]!, HUMAN)
    const { runner, events } = await dormant(peer, known, { backfillHistory: false })

    runner.sendMessage('carry on')
    await eventually(() => expect(requests(peer, 'turn/start')).toHaveLength(1))
    expect(runner.status).toBe('running')
    play.notes()

    await runner.interrupt()
    expect(requests(peer, 'thread/goal/set')[0]!.params).toEqual({ threadId: 'thread-1', status: 'paused', origin: 'user' })
    expect(requests(peer, 'turn/interrupt')[0]!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-3' })
    expect(ofType(events, 'turn_result')).toEqual([expect.objectContaining({ subtype: 'error_during_execution', errors: ['interrupted'] })])
    expect(runner.info().goal).toMatchObject({ state: 'paused', setBy: HUMAN })
    expect(notices(events)).toEqual(['paused'])
    expect(runner.status).toBe('idle')
  })

  it('an interrupted goal turn: Stop pauses the goal so no wake restarts it', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('interrupted')
    const goals = fixtureGoals(lines)
    playFixture(peer, lines, { 'thread/goal/set': () => ({ goal: { ...goals.at(-1)!, status: 'paused' } }) })
    const { runner, events } = await freshRunner(peer)

    await runner.setGoal({ text: goals[0]!.objective, tokenBudget: 40000 }, HUMAN)
    await eventually(() => expect(runner.status).toBe('running'))
    await runner.interrupt()

    expect(requests(peer, 'thread/goal/set').map((r) => (r.params as { status: string }).status)).toEqual(['active', 'paused'])
    expect(ofType(events, 'turn_result')).toEqual([expect.objectContaining({ errors: ['interrupted'] })])
    expect(runner.info().goal?.state).toBe('paused')
    expect(notices(events)).toEqual(['set', 'paused'])
  })

  it('passive dormant attach: thread/read + thread/goal/get only, no turn, the stored setter is kept, no notice', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('passive-attach')
    const engineGoal = fixtureGoals(lines)[0]!
    playFixture(peer, lines)
    const known = storedGoal({ ...engineGoal, tokensUsed: 0, timeUsedSeconds: 4 }, HUMAN)
    const { runner, events } = await dormant(peer, known, { startAsleep: true })

    expect(peer.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'skills/list', 'thread/read', 'thread/goal/get'])
    expect(runner.status).toBe('idle')
    expect(runner.engineAsleep).toBe(true)
    expect(runner.info().goal).toMatchObject({ state: 'active', tokensUsed: 1686, timeUsedSeconds: 19, setBy: HUMAN })
    expect(notices(events)).toEqual([])
    expect(goalEvents(events)).toHaveLength(1)
  })

  it('a send during a goal turn steers into it: one turn, one result, met', async () => {
    const peer = scriptedPeer()
    const lines = goalFixture('user-turn')
    const play = playFixture(peer, lines, { 'turn/steer': () => ({ turnId: 'turn-1' }) })
    const { runner, events } = await freshRunner(peer)

    await runner.setGoal({ text: fixtureGoals(lines)[0]!.objective, tokenBudget: 40000 }, HUMAN)
    await eventually(() => expect(runner.status).toBe('running'))
    runner.sendMessage('Also, reply with the word PING once.')
    await eventually(() => expect(requests(peer, 'turn/steer')).toHaveLength(1))
    play.rest('thread/goal/clear')
    await eventually(() => expect(runner.status).toBe('idle'))

    expect(requests(peer, 'turn/start')).toHaveLength(0)
    expect(ofType(events, 'turn_result')).toEqual([
      expect.objectContaining({ subtype: 'success', result: expect.stringContaining('PING') }),
    ])
    expect(notices(events)).toEqual(['set', 'met'])
  })
})

describe('CodexRunner goals: scripted', () => {
  it('replace: a second set is a new goal with its own setter', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    let createdAt = 1_800_000_000
    peer.respond('thread/goal/set', (params) => {
      const { objective } = params as { objective: string }
      const goal = threadGoal({ objective, createdAt, updatedAt: createdAt })
      createdAt += 5
      peer.emit('thread/goal/updated', updated(goal))
      return { goal }
    })

    await runner.setGoal({ text: 'first' }, LEAD)
    const second = await runner.setGoal({ text: 'second' }, HUMAN)
    expect(second).toMatchObject({ text: 'second', setBy: HUMAN, setAt: 1_800_000_005_000 })
    expect(notices(events)).toEqual(['set', 'set'])
    expect(goalEvents(events)).toHaveLength(2)
  })

  it('a response overtaken by a newer notification is not applied over it', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const set = threadGoal()
    peer.respond('thread/goal/set', () => {
      peer.emit('thread/goal/updated', updated(set))
      peer.emit('thread/goal/updated', updated({ ...set, tokensUsed: 900, timeUsedSeconds: 1, updatedAt: set.updatedAt + 1 }, 'goal-turn'))
      return { goal: set }
    })

    const goal = await runner.setGoal({ text: 'ship it' }, HUMAN)
    expect(goal.tokensUsed).toBe(900)
    expect(runner.info().goal).toMatchObject({ tokensUsed: 900, setBy: HUMAN })
    expect(goalEvents(events).map((event) => event.notice)).toEqual(['set', undefined])
  })

  it('a response before its notification: one event', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const set = threadGoal()
    peer.respond('thread/goal/set', () => {
      queueMicrotask(() => queueMicrotask(() => peer.emit('thread/goal/updated', updated(set))))
      return { goal: set }
    })
    await runner.setGoal({ text: 'ship it' }, HUMAN)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(goalEvents(events)).toHaveLength(1)
  })

  it("the codex model's own goal is the agent's; later updates of it keep that setter", async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer, { agent: { name: 'Builder' } })
    const goal = threadGoal({ objective: 'model goal' })

    peer.emit('thread/goal/updated', updated(goal, 'turn-x'))
    peer.emit('thread/goal/updated', updated({ ...goal, status: 'blocked', updatedAt: goal.updatedAt + 3 }))
    expect(runner.info().goal).toMatchObject({ state: 'blocked', setBy: { kind: 'agent', sessionId: runner.id, name: 'Builder' } })
    expect(notices(events)).toEqual(['set', 'blocked'])
  })

  it('usage limits and automatic stops map to their states', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const goal = threadGoal()
    for (const status of ['active', 'usageLimited', 'paused', 'active', 'complete'] as const) {
      peer.emit('thread/goal/updated', updated({ ...goal, status }))
    }
    expect(notices(events)).toEqual(['set', 'limited', 'paused', 'resumed', 'met'])
    expect(goalEvents(events)[1]!.goal).toMatchObject({ state: 'limited', limit: 'usage' })
    expect(runner.info().goal?.state).toBe('met')
  })

  it('child threads never set the root goal', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    peer.emit('thread/goal/updated', updated(threadGoal({ threadId: 'child' })))
    peer.emit('thread/goal/updated', { ...updated(threadGoal({ threadId: 'child' })), threadId: 'thread-1' })
    peer.emit('thread/goal/cleared', { threadId: 'child' })
    expect(goalEvents(events)).toHaveLength(0)
    expect(runner.info().goal).toBeUndefined()
  })

  it('a cut with an active goal pauses it first; the old thread is then ignored and the reset drops the goal', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const goal = threadGoal()
    peer.emit('thread/goal/updated', updated(goal))
    peer.respond('thread/goal/set', () => ({ goal: { ...goal, status: 'paused' } }))
    peer.respond('thread/start', () => ({ thread: { id: 'thread-2' }, model: 'gpt-5.6-terra' }))

    await runner.clearContext()
    const methods = peer.requests.map((r) => r.method)
    expect(methods.lastIndexOf('thread/goal/set')).toBeLessThan(methods.lastIndexOf('thread/start'))
    expect(notices(events)).toEqual(['set', 'paused'])
    expect(runner.info().goal).toBeUndefined()

    peer.emit('thread/goal/updated', updated({ ...goal, status: 'active' }))
    expect(runner.info().goal).toBeUndefined()
  })

  it('explicit sleep pauses an active goal first; a refused pause refuses the sleep', async () => {
    const peer = scriptedPeer()
    const { runner } = await liveIdleRunner(peer)
    const goal = threadGoal()
    peer.emit('thread/goal/updated', updated(goal))
    peer.respond('thread/goal/set', () => {
      throw new JsonRpcError(-32603, 'goals db is locked')
    })
    expect(await runner.sleep()).toEqual({
      ok: false,
      reason: 'could not pause the goal: codex refused the goal change: goals db is locked',
    })
    expect(runner.engineAsleep).toBe(false)

    peer.respond('thread/goal/set', () => ({ goal: { ...goal, status: 'paused' } }))
    expect(await runner.sleep()).toEqual({ ok: true })
    expect(runner.engineAsleep).toBe(true)
    expect(runner.info().goal?.state).toBe('paused')
  })

  it('pause and clear on an asleep runner use a scratch connection and never resume', async () => {
    const peer = scriptedPeer()
    const known = storedGoal(threadGoal(), HUMAN, 'paused')
    const { runner, events } = await dormant(peer, known, { backfillHistory: false, startAsleep: true })
    peer.respond('thread/goal/clear', () => ({ cleared: true }))

    await runner.clearGoal()
    expect(requests(peer, 'thread/resume')).toHaveLength(0)
    expect(requests(peer, 'thread/goal/clear')[0]!.params).toEqual({ threadId: 'thread-1', origin: 'user' })
    expect(peer.closed()).toBe(1)
    expect(runner.engineAsleep).toBe(true)
    expect(notices(events)).toEqual(['cleared'])
  })

  it('set on an asleep runner wakes it like a send', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await dormant(peer, undefined, { backfillHistory: false, startAsleep: true })
    peer.respond('thread/goal/set', () => ({ goal: threadGoal() }))

    await runner.setGoal({ text: 'ship it' }, HUMAN)
    expect(runner.engineAsleep).toBe(false)
    expect(peer.requests.map((r) => r.method).filter((m) => m.startsWith('thread/'))).toEqual([
      'thread/resume',
      'thread/goal/get',
      'thread/goal/set',
    ])
    expect(ofType(events, 'engine_sleep').map((event) => event.asleep)).toEqual([true, false])
  })

  it('an unsupported binary rejects and turns the capability off; a refusal says so', async () => {
    const peer = scriptedPeer()
    const { runner } = await liveIdleRunner(peer)
    peer.respond('thread/goal/set', () => {
      throw new JsonRpcError(-32600, 'goals are disabled for this thread')
    })
    await expect(runner.setGoal({ text: 'ship it' }, HUMAN)).rejects.toThrow(
      'codex refused the goal change: goals are disabled for this thread',
    )
    expect(runner.info().capabilities?.goals).toEqual({ pause: true, budget: true })

    peer.respond('thread/goal/set', () => {
      throw new JsonRpcError(-32600, 'Invalid request: unknown variant `thread/goal/set`, expected one of ...')
    })
    await expect(runner.setGoal({ text: 'ship it' }, HUMAN)).rejects.toThrow('does not support goals')
    expect(runner.info().capabilities?.goals).toBeUndefined()
  })

  describe('hydration against the stored goal', () => {
    it('a null tombstone keeps a finished engine goal hidden', async () => {
      const peer = scriptedPeer()
      peer.respond('thread/read', () => ({ thread: { id: 'thread-1', turns: [] } }))
      peer.respond('thread/goal/get', () => ({ goal: threadGoal({ status: 'complete' }) }))
      const { runner, events } = await dormant(peer, null)
      expect(runner.info().goal).toBeUndefined()
      expect(goalEvents(events)).toHaveLength(0)
    })

    it('a null tombstone gives way to an active engine goal: work the engine would run', async () => {
      const peer = scriptedPeer()
      peer.respond('thread/read', () => ({ thread: { id: 'thread-1', turns: [] } }))
      peer.respond('thread/goal/get', () => ({ goal: threadGoal() }))
      const { runner } = await dormant(peer, null)
      expect(runner.info().goal).toMatchObject({ state: 'active', setBy: { kind: 'agent', sessionId: runner.id } })
    })

    it('a different engine goal replaces the stored one; an engine with none clears it', async () => {
      const peer = scriptedPeer()
      peer.respond('thread/read', () => ({ thread: { id: 'thread-1', turns: [] } }))
      peer.respond('thread/goal/get', () => ({ goal: threadGoal({ objective: 'newer', createdAt: 1_800_000_100 }) }))
      const { runner } = await dormant(peer, storedGoal(threadGoal(), HUMAN))
      expect(runner.info().goal).toMatchObject({ text: 'newer', setBy: { kind: 'agent' } })

      const other = scriptedPeer()
      other.respond('thread/read', () => ({ thread: { id: 'thread-1', turns: [] } }))
      other.respond('thread/goal/get', () => ({ goal: null }))
      const second = await dormant(other, storedGoal(threadGoal(), HUMAN))
      expect(second.runner.info().goal).toBeUndefined()
      expect(notices(second.events)).toEqual([])
    })
  })
})
