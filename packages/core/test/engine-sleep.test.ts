import { describe, expect, it } from 'vitest'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@workerdeck/protocol'
import { CostLedger, SessionRunner } from '../src/index.ts'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

function init(model = 'claude-test-1'): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-session-1',
    model,
    cwd: '/tmp/project',
    tools: [],
    skills: [],
    slash_commands: [],
    permissionMode: 'default',
    claude_code_version: '2.0.0',
    mcp_servers: [],
    apiKeySource: 'user',
    uuid: 'uuid-init',
  } as unknown as SDKMessage
}

function result(totalCostUsd: number): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: totalCostUsd,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: `uuid-r-${totalCostUsd}`,
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage
}

function textOf(input: SDKUserMessage): string {
  const content = input.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

// One fake query per engine process: sleep ends one and the wake starts the next.
function processes() {
  const harnesses: ReturnType<typeof fakeHarness>[] = []
  const options: (Options | undefined)[] = []
  const queryFn = (params: Parameters<ReturnType<typeof fakeHarness>['queryFn']>[0]) => {
    const harness = fakeHarness()
    harnesses.push(harness)
    const query = harness.queryFn(params)
    options.push(harness.captured.options)
    return query
  }
  return { harnesses, options, queryFn }
}

async function idleClaude() {
  const engine = processes()
  const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: engine.queryFn, model: 'claude-config' })
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  void runner.start()
  await tick()
  runner.sendMessage('first')
  engine.harnesses[0]!.emit(init())
  engine.harnesses[0]!.emit(result(0.5))
  await tick()
  return { engine, runner, events }
}

describe('claude engine sleep', () => {
  it('ends the query without closing the session and resumes it on the next message', async () => {
    const { engine, runner, events } = await idleClaude()
    expect(runner.status).toBe('idle')

    expect(await runner.sleep()).toEqual({ ok: true })
    engine.harnesses[0]!.end()
    await tick()
    expect(runner.info().engineAsleep).toBe(true)
    expect(runner.status).toBe('idle')
    expect(events.some((e) => e.type === 'session_closed')).toBe(false)

    runner.sendMessage('second')
    await tick()
    expect(engine.harnesses).toHaveLength(2)
    expect(engine.options[1]?.resume).toBe('sdk-session-1')
    expect(engine.options[1]?.forkSession).toBe(false)
    expect(engine.harnesses[1]!.captured.inputs.map(textOf)).toEqual(['second'])
    expect(runner.info().engineAsleep).toBeUndefined()

    const sleeps = ofType(events, 'engine_sleep').map((e) => e.asleep)
    expect(sleeps).toEqual([true, false])
    const wake = events.findIndex((e) => e.type === 'engine_sleep' && !e.asleep)
    expect(events[wake + 1]).toMatchObject({ type: 'status_changed', status: 'starting' })
    expect(events.slice(wake).find((e) => e.type === 'user_message')).toBeDefined()
    expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index + 1))

    engine.harnesses[1]!.emit(init())
    engine.harnesses[1]!.emit(result(0.75))
    await tick()
    expect(runner.status).toBe('idle')
    expect(runner.info().totalCostUsd).toBe(0.75)
  })

  it('applies a model and permission mode chosen while asleep at the wake', async () => {
    const { engine, runner } = await idleClaude()
    await runner.sleep()
    await runner.setModel('claude-other')
    await runner.setPermissionMode('acceptEdits')
    runner.sendMessage('go')
    await tick()
    expect(engine.options[1]).toMatchObject({ model: 'claude-other', permissionMode: 'acceptEdits' })
  })

  it('refuses while a turn runs, before any conversation exists, and once closed', async () => {
    const engine = processes()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: engine.queryFn })
    void runner.start()
    await tick()
    expect(await runner.sleep()).toEqual({ ok: false, reason: 'the engine has not started a conversation yet' })

    runner.sendMessage('first')
    engine.harnesses[0]!.emit(init())
    await tick()
    expect(await runner.sleep()).toEqual({ ok: false, reason: 'session is running' })

    engine.harnesses[0]!.emit(result(0.1))
    await tick()
    runner.close()
    expect(await runner.sleep()).toEqual({ ok: false, reason: 'session is closed' })
  })

  it('sleeps a resumed session that has not run a turn yet, and wakes it into the same conversation', async () => {
    const engine = processes()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: engine.queryFn, resume: 'sdk-prior', backfillHistory: false })
    void runner.start()
    await tick()
    expect(runner.info().sdkSessionId).toBe('sdk-prior')
    expect(await runner.sleep()).toEqual({ ok: true })
    runner.sendMessage('hello')
    await tick()
    expect(engine.options[1]).toMatchObject({ resume: 'sdk-prior', forkSession: false })
  })

  it('starts asleep when asked, opening no query until the first message', async () => {
    const engine = processes()
    const runner = new SessionRunner({
      cwd: '/tmp/project',
      queryFn: engine.queryFn,
      resume: 'sdk-prior',
      backfillHistory: false,
      startAsleep: true,
    })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    void runner.start()
    await tick()
    expect(engine.harnesses).toHaveLength(0)
    expect(runner.info().engineAsleep).toBe(true)
    expect(runner.status).toBe('idle')

    runner.sendMessage('hello')
    await tick()
    expect(engine.harnesses).toHaveLength(1)
    expect(engine.options[0]).toMatchObject({ resume: 'sdk-prior', forkSession: false })
    expect(engine.harnesses[0]!.captured.inputs.map(textOf)).toEqual(['hello'])
    expect(ofType(events, 'engine_sleep').map((e) => e.asleep)).toEqual([true, false])
  })

  it('does not start a fork asleep, since the fork has no conversation of its own yet', async () => {
    const engine = processes()
    const runner = new SessionRunner({
      cwd: '/tmp/project',
      queryFn: engine.queryFn,
      resume: 'sdk-prior',
      forkSession: true,
      backfillHistory: false,
      startAsleep: true,
    })
    void runner.start()
    await tick()
    expect(engine.harnesses).toHaveLength(1)
    expect(runner.info().engineAsleep).toBeUndefined()
  })

  it('treats the end of a query that was not put to sleep as the session ending', async () => {
    const { engine, runner, events } = await idleClaude()
    engine.harnesses[0]!.end()
    await tick()
    expect(events.some((e) => e.type === 'session_closed')).toBe(true)
    expect(runner.status).toBe('closed')
  })

  it('does not count a sleep as activity', async () => {
    const { runner } = await idleClaude()
    const before = runner.info().lastActivityAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runner.sleep()
    expect(runner.info().lastActivityAt).toBe(before)
  })
})

describe('CostLedger.restartProcess', () => {
  it('keeps the total when the next process restores it', () => {
    const ledger = new CostLedger()
    ledger.observeCumulative(undefined, 0.5)
    ledger.restartProcess()
    expect(ledger.reportedCostUsd).toBe(0.5)
    ledger.observeCumulative(undefined, 0.75)
    expect(ledger.reportedCostUsd).toBe(0.75)
  })

  it('adds the earlier total when the next process counts from zero', () => {
    const ledger = new CostLedger()
    ledger.observeCumulative(undefined, 0.5)
    ledger.restartProcess()
    ledger.observeCumulative(undefined, 0.25)
    expect(ledger.reportedCostUsd).toBe(0.75)
  })
})

describe('codex engine sleep', () => {
  it('closes the app-server without an error and resumes the thread on the next turn', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    runner.sendMessage('first')
    await tick()
    await tick()
    expect(runner.status).toBe('idle')
    const connected = peer.connections()
    const closed = peer.closed()

    expect(await runner.sleep()).toEqual({ ok: true })
    expect(peer.closed()).toBe(closed + 1)
    expect(runner.info().engineAsleep).toBe(true)

    runner.sendMessage('second')
    await tick()
    await tick()
    expect(peer.connections()).toBe(connected + 1)
    const resumed = peer.requests.find((r) => r.connection === connected + 1 && r.method === 'thread/resume')
    expect(resumed?.params).toMatchObject({ threadId: 'thread-1' })
    expect(runner.info().engineAsleep).toBeUndefined()
    expect(ofType(events, 'engine_sleep').map((e) => e.asleep)).toEqual([true, false])
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('starts asleep after the resume backfill, closing the app-server it read history from', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'thread-1', connectFn: peer.connectFn, startAsleep: true })
    await runner.start()
    expect(runner.info().engineAsleep).toBe(true)
    expect(peer.closed()).toBe(peer.connections())

    runner.sendMessage('hello')
    await tick()
    await tick()
    expect(runner.info().engineAsleep).toBeUndefined()
    expect(peer.connections()).toBe(2)
  })

  it('refuses mid-turn', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    await runner.start()
    runner.sendMessage('first')
    await tick()
    const refused = await runner.sleep()
    expect(refused.ok).toBe(false)
    runner.close()
  })
})
