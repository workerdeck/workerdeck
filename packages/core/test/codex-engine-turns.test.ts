import { describe, expect, it } from 'vitest'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import { THREAD_RESULT, collect, ofType, scriptTurn, scriptedPeer, type ScriptedPeer } from './helpers/codex-peer.ts'
import { eventually } from './helpers/wait.ts'

// Turns codex starts on its own: a goal continuation, or the turn a `thread/resume` restarts.
function engine(peer: ScriptedPeer) {
  return {
    start: (turnId: string, threadId = 'thread-1') => peer.emit('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } }),
    say: (turnId: string, text: string, threadId = 'thread-1') =>
      peer.emit('item/completed', { threadId, turnId, item: { id: `${turnId}-msg`, type: 'agentMessage', text } }),
    complete: (turnId: string, status = 'completed', threadId = 'thread-1') =>
      peer.emit('turn/completed', { threadId, turn: { id: turnId, status } }),
  }
}

async function liveIdleRunner(peer: ScriptedPeer) {
  scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }), 'turn-0')
  const runner = new CodexRunner({ cwd: '/tmp', prompt: 'set things up', connectFn: peer.connectFn })
  const events = collect(runner)
  await runner.start()
  expect(ofType(events, 'turn_result')).toHaveLength(1)
  return { runner, events }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('CodexRunner: turns the engine starts by itself', () => {
  it('owns an unsolicited root turn: running, its text, exactly one result, back to idle, no user row', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const turns = engine(peer)

    turns.start('goal-1')
    expect(runner.status).toBe('running')
    turns.say('goal-1', 'kept going')
    turns.complete('goal-1')
    turns.complete('goal-1')
    await eventually(() => expect(runner.status).toBe('idle'))

    const results = ofType(events, 'turn_result')
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({ subtype: 'success', result: 'kept going', numTurns: 2 })
    expect(ofType(events, 'user_message').filter((e) => !e.synthetic)).toHaveLength(1)
    expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1)
  })

  it('a send during an engine turn steers into it and never opens a second turn', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const turns = engine(peer)
    peer.respond('turn/steer', () => ({ turnId: 'goal-1' }))

    turns.start('goal-1')
    runner.sendMessage('also look at the tests')
    await eventually(() => expect(peer.requests.filter((r) => r.method === 'turn/steer')).toHaveLength(1))
    expect(peer.requests.find((r) => r.method === 'turn/steer')!.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'goal-1' })
    turns.complete('goal-1')
    await eventually(() => expect(runner.status).toBe('idle'))

    expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1)
    expect(ofType(events, 'turn_result')).toHaveLength(2)
  })

  it('back to back: the old turn finalizing never idles the new one or settles its approvals', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const turns = engine(peer)

    turns.start('goal-1')
    turns.complete('goal-1')
    turns.start('goal-2')
    await tick()
    expect(runner.status).toBe('running')
    expect(ofType(events, 'turn_result')).toHaveLength(2)

    const approval = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'goal-2',
      itemId: 'cmd-1',
      command: 'ls',
      cwd: '/tmp',
    })
    await eventually(() => expect(runner.status).toBe('awaiting_approval'))
    turns.complete('goal-2')
    await approval
    await eventually(() => expect(runner.status).toBe('idle'))
    expect(ofType(events, 'turn_result')).toHaveLength(3)
  })

  it('a send queued behind an engine turn waits for it, then runs as its own turn', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const turns = engine(peer)
    peer.respond('turn/steer', () => {
      throw new JsonRpcError(-32601, 'method not found')
    })

    turns.start('goal-1')
    runner.sendMessage('after the goal turn')
    await eventually(() => expect(peer.requests.filter((r) => r.method === 'turn/steer')).toHaveLength(1))
    await tick()
    expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1)

    scriptTurn(
      peer,
      (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }),
      'turn-2',
    )
    turns.complete('goal-1')
    await eventually(() => expect(ofType(events, 'turn_result')).toHaveLength(3))
    expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2)
    expect(runner.status).toBe('idle')
  })

  it('interrupts an engine turn by its own id', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const turns = engine(peer)
    peer.respond('turn/interrupt', () => {
      turns.complete('goal-1', 'interrupted')
      return {}
    })

    turns.start('goal-1')
    await runner.interrupt()

    expect(peer.requests.find((r) => r.method === 'turn/interrupt')!.params).toEqual({ threadId: 'thread-1', turnId: 'goal-1' })
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'error_during_execution', errors: ['interrupted'] })
    expect(runner.status).toBe('idle')
  })

  it('a dead child fails the engine turn it owned', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    engine(peer).start('goal-1')
    peer.die('codex app-server exited (code 1): gone')
    await eventually(() => expect(runner.status).toBe('idle'))
    expect(ofType(events, 'turn_result')[1]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['codex app-server exited (code 1): gone'],
    })
  })

  it('a child thread starting a turn is not a root turn', async () => {
    const peer = scriptedPeer()
    const { runner, events } = await liveIdleRunner(peer)
    const turns = engine(peer)
    turns.start('child-turn', 'thread-child')
    turns.complete('child-turn', 'completed', 'thread-child')
    await tick()
    expect(runner.status).toBe('idle')
    expect(ofType(events, 'turn_result')).toHaveLength(1)
  })

  it('wake race: a resume that restarts the goal binds the send to that turn; one result', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => {
      engine(peer).start('goal-1', 'prior')
      return { ...THREAD_RESULT, thread: { id: 'prior' } }
    })
    peer.respond('turn/start', () => ({ turn: { id: 'goal-1', status: 'inProgress' } }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', backfillHistory: false, connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    runner.sendMessage('carry on')
    await eventually(() => expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1))
    expect(runner.status).toBe('running')
    engine(peer).complete('goal-1', 'completed', 'prior')
    await eventually(() => expect(runner.status).toBe('idle'))
    expect(ofType(events, 'turn_result')).toHaveLength(1)
  })

  it('wake race: the restarted turn ends before the send lands; the send opens a turn that is still owned', async () => {
    const peer = scriptedPeer()
    const turns = engine(peer)
    peer.respond('thread/resume', () => {
      turns.start('goal-1', 'prior')
      turns.complete('goal-1', 'completed', 'prior')
      return { ...THREAD_RESULT, thread: { id: 'prior' } }
    })
    let finish: (() => void) | undefined
    peer.respond('turn/start', () => {
      turns.start('turn-2', 'prior')
      finish = () => {
        turns.say('turn-2', 'answered', 'prior')
        turns.complete('turn-2', 'completed', 'prior')
      }
      return { turn: { id: 'turn-2', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', backfillHistory: false, connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    runner.sendMessage('carry on')
    await eventually(() => expect(finish).toBeDefined())
    await tick()
    expect(runner.status).toBe('running')
    finish!()
    await eventually(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success', result: 'answered' })
    expect(runner.status).toBe('idle')
  })

  it('refuses to sleep while an engine turn runs', async () => {
    const peer = scriptedPeer()
    const { runner } = await liveIdleRunner(peer)
    engine(peer).start('goal-1')
    expect(await runner.sleep()).toMatchObject({ ok: false })
  })
})
