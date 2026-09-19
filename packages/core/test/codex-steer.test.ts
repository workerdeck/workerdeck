import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import { THREAD_RESULT, collect, ofType, scriptedPeer, type ScriptedPeer } from './helpers/codex-peer.ts'

// The exact shape 0.153.4 answers an unknown method with: serde misses the ClientRequest variant, so it is -32600, not -32601.
const UNKNOWN_VARIANT = 'Invalid request: unknown variant `turn/steer`, expected one of `initialize`, `turn/start`, `turn/interrupt`'

function steers(peer: ScriptedPeer) {
  return peer.requests.filter((r) => r.method === 'turn/steer')
}

function starts(peer: ScriptedPeer) {
  return peer.requests.filter((r) => r.method === 'turn/start')
}

function userTexts(events: SessionEvent[]): unknown[] {
  return ofType(events, 'user_message')
    .filter((e) => !e.synthetic)
    .map((e) => e.message.content)
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Every turn/start opens turn-N on the thread it was asked for and hangs until `complete` ends it.
function hangingTurns(peer: ScriptedPeer) {
  let index = 0
  const threads = new Map<string, string>()
  peer.respond('turn/start', (params) => {
    const turnId = `turn-${++index}`
    const threadId = (params as { threadId: string }).threadId
    threads.set(turnId, threadId)
    peer.emit('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
    return { turn: { id: turnId, status: 'inProgress' } }
  })
  return {
    complete: (turnId: string, status = 'completed') => {
      peer.emit('turn/completed', { threadId: threads.get(turnId), turn: { id: turnId, status } })
    },
  }
}

describe('CodexRunner: mid-turn messages steer the running turn', () => {
  it('steers into the running turn, in order, and never opens a second turn/start', async () => {
    const peer = scriptedPeer()
    const turns = hangingTurns(peer)
    peer.respond('turn/steer', () => ({ turnId: 'turn-1' }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('also this')
    runner.sendMessage('and this')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(2))
    expect(steers(peer)[0]!.params).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'also this' }],
    })
    expect(steers(peer)[1]!.params).toMatchObject({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'and this' }] })
    expect(starts(peer)).toHaveLength(1)
    expect(runner.status).toBe('running')
    expect(ofType(events, 'turn_result')).toHaveLength(0)

    // Codex echoes the steered input as its own root-thread userMessage item; the runner's echo is the one the transcript keeps.
    for (const method of ['item/started', 'item/completed']) {
      peer.emit(method, {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'also this' }] },
      })
    }
    peer.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: 'did both' } })
    turns.complete('turn-1')
    await run

    expect(userTexts(events)).toEqual(['first', 'also this', 'and this'])
    expect(ofType(events, 'turn_result')).toHaveLength(1)
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success', numTurns: 1, result: 'did both' })
    expect(runner.info().numTurns).toBe(1)
    expect(starts(peer)).toHaveLength(1)
    expect(runner.status).toBe('idle')
  })

  it('a message sent between turns takes turn/start and never touches turn/steer', async () => {
    const peer = scriptedPeer()
    let index = 0
    peer.respond('turn/start', () => {
      const turnId = `turn-${++index}`
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    runner.sendMessage('second')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    expect(steers(peer)).toHaveLength(0)
    expect(starts(peer)).toHaveLength(2)
    expect(starts(peer)[1]!.params).toMatchObject({ input: [{ type: 'text', text: 'second' }] })
    expect(userTexts(events)).toEqual(['first', 'second'])
  })

  it('falls back to a follow-up turn when the steer loses the race with turn/completed', async () => {
    const peer = scriptedPeer()
    let index = 0
    peer.respond('turn/start', () => {
      const turnId = `turn-${++index}`
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
      if (index === 2) {
        peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
      }
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    peer.respond('turn/steer', () => {
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
      throw new JsonRpcError(-32600, 'turn-1 is not the active turn')
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('late')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    expect(steers(peer)).toHaveLength(1)
    expect(starts(peer)).toHaveLength(2)
    expect(starts(peer)[1]!.params).toMatchObject({ threadId: 'thread-1', input: [{ type: 'text', text: 'late' }] })
    expect(userTexts(events)).toEqual(['first', 'late'])
    expect(ofType(events, 'turn_result').map((r) => r.numTurns)).toEqual([1, 2])
    expect(runner.status).toBe('idle')
  })

  it.each([
    ['-32601', new JsonRpcError(-32601, 'Method not found')],
    ['-32600 unknown variant', new JsonRpcError(-32600, UNKNOWN_VARIANT)],
  ])('remembers a child that cannot steer (%s), queues in order, and probes again after a respawn', async (_label, rejection) => {
    const peer = scriptedPeer()
    const turns = hangingTurns(peer)
    peer.respond('turn/steer', () => {
      throw rejection
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('a')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(1))
    runner.sendMessage('b')
    await settle()
    expect(steers(peer)).toHaveLength(1)
    expect(starts(peer)).toHaveLength(1)

    turns.complete('turn-1')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(2))
    expect(starts(peer)[1]!.params).toMatchObject({ input: [{ type: 'text', text: 'a' }] })
    turns.complete('turn-2')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(3))
    expect(starts(peer)[2]!.params).toMatchObject({ input: [{ type: 'text', text: 'b' }] })
    turns.complete('turn-3')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
    expect(steers(peer)).toHaveLength(1)
    expect(userTexts(events)).toEqual(['first', 'a', 'b'])
    expect(ofType(events, 'turn_result')).toHaveLength(3)

    peer.die('codex app-server exited (code 1): boom')
    runner.sendMessage('c')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(4))
    expect(starts(peer)[3]!.connection).toBe(2)
    runner.sendMessage('d')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(2))
    expect(steers(peer)[1]).toMatchObject({ connection: 2, params: { threadId: 'thread-1', expectedTurnId: 'turn-4' } })
    turns.complete('turn-4')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(5))
    expect(starts(peer)[4]!.params).toMatchObject({ input: [{ type: 'text', text: 'd' }] })
    turns.complete('turn-5')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
    expect(userTexts(events)).toEqual(['first', 'a', 'b', 'c', 'd'])
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('an unrelated steer rejection is not remembered: the next message tries again', async () => {
    const peer = scriptedPeer()
    const turns = hangingTurns(peer)
    let attempts = 0
    peer.respond('turn/steer', () => {
      if (++attempts === 1) {
        throw new JsonRpcError(-32600, 'invalid thread id: ...')
      }
      return { turnId: 'turn-1' }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('a')
    runner.sendMessage('b')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(2))
    expect(starts(peer)).toHaveLength(1)
    turns.complete('turn-1')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(2))
    expect(starts(peer)[1]!.params).toMatchObject({ input: [{ type: 'text', text: 'a' }] })
    turns.complete('turn-2')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
    expect(starts(peer)).toHaveLength(2)
  })

  it('a message sent before the turn id is known waits for it, then steers', async () => {
    const peer = scriptedPeer()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    peer.respond('turn/start', async () => {
      await released
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } })
      return { turn: { id: 'turn-1', status: 'inProgress' } }
    })
    peer.respond('turn/steer', () => ({ turnId: 'turn-1' }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('early')
    await settle()
    expect(steers(peer)).toHaveLength(0)
    expect(starts(peer)).toHaveLength(1)
    expect(userTexts(events)).toEqual(['first', 'early'])

    release()
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(1))
    expect(steers(peer)[0]!.params).toMatchObject({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'early' }] })
    peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
    expect(starts(peer)).toHaveLength(1)
    expect(ofType(events, 'turn_result')).toHaveLength(1)
  })

  it('a message parked behind a turn/start that fails runs as its own turn instead of being dropped', async () => {
    const peer = scriptedPeer()
    let index = 0
    let fail!: () => void
    const failed = new Promise<void>((resolve) => {
      fail = resolve
    })
    peer.respond('turn/start', async () => {
      if (++index === 1) {
        await failed
        throw new JsonRpcError(-32600, 'model unavailable')
      }
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'inProgress' } })
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } })
      return { turn: { id: 'turn-2', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('parked')
    fail()
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    expect(steers(peer)).toHaveLength(0)
    expect(starts(peer)[1]!.params).toMatchObject({ input: [{ type: 'text', text: 'parked' }] })
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'error_during_execution', errors: ['model unavailable'] })
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success' })
    expect(userTexts(events)).toEqual(['first', 'parked'])
  })

  it('queues behind a pending /clear instead of steering into the turn about to be cleared', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    const turns = hangingTurns(peer)
    peer.respond('turn/steer', () => ({ turnId: 'turn-1' }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    const clear = runner.clearContext()
    runner.sendMessage('after the clear')
    await settle()
    expect(steers(peer)).toHaveLength(0)
    turns.complete('turn-1')
    await clear
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(2))
    expect(steers(peer)).toHaveLength(0)
    expect(starts(peer)[1]!.params).toMatchObject({ threadId: 'thread-2', input: [{ type: 'text', text: 'after the clear' }] })
    expect(ofType(events, 'conversation_reset')).toHaveLength(1)
    turns.complete('turn-2')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))

    runner.sendMessage('steer me')
    await settle()
    expect(steers(peer)).toHaveLength(0)
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(3))
    runner.sendMessage('now mid-turn')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(1))
    expect(steers(peer)[0]!.params).toMatchObject({ threadId: 'thread-2', expectedTurnId: 'turn-3' })
    turns.complete('turn-3')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
  })

  it('queues rather than steers once an interrupt is in flight', async () => {
    const peer = scriptedPeer()
    const turns = hangingTurns(peer)
    peer.respond('turn/interrupt', () => {
      turns.complete('turn-1', 'interrupted')
      return {}
    })
    peer.respond('turn/steer', () => ({ turnId: 'turn-1' }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    // interrupt() drains the whole chain, and the queued follow-up is on it, so it resolves only once turn-2 ends.
    const stop = runner.interrupt()
    runner.sendMessage('next')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(2))
    expect(steers(peer)).toHaveLength(0)
    expect(starts(peer)[1]!.params).toMatchObject({ input: [{ type: 'text', text: 'next' }] })
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'error_during_execution', errors: ['interrupted'] })
    turns.complete('turn-2')
    await stop
    expect(runner.status).toBe('idle')
    expect(userTexts(events)).toEqual(['first', 'next'])
  })

  it('steers while the turn is blocked on an approval and leaves the card pending', async () => {
    const peer = scriptedPeer()
    let approvalResponse: unknown
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } })
      peer.emit('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'exec-1', type: 'commandExecution', command: 'rm -rf build', status: 'inProgress' },
      })
      void peer
        .serverRequest('item/commandExecution/requestApproval', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'exec-1',
          command: 'rm -rf build',
          cwd: '/tmp',
          reason: 'command failed; retry without sandbox?',
        })
        .then((response) => {
          approvalResponse = response
          peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        })
      return { turn: { id: 'turn-1', status: 'inProgress' } }
    })
    peer.respond('turn/steer', () => ({ turnId: 'turn-1' }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(ofType(events, 'permission_requested')).toHaveLength(1))
    expect(runner.status).toBe('awaiting_approval')

    runner.sendMessage('no, only the dist folder')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(1))
    expect(steers(peer)[0]!.params).toMatchObject({ expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'no, only the dist folder' }] })
    expect(runner.status).toBe('awaiting_approval')
    expect(runner.info().pendingPermissionCount).toBe(1)
    expect(starts(peer)).toHaveLength(1)

    const request = ofType(events, 'permission_requested')[0]!.request
    expect(runner.resolvePermission(request.id, { behavior: 'deny', message: 'no' })).toBe(true)
    await run
    expect(approvalResponse).toEqual({ decision: 'decline' })
    expect(ofType(events, 'turn_result')).toHaveLength(1)
    expect(runner.status).toBe('idle')
  })

  it('held local-command output rides the steered input, ahead of the text', async () => {
    const peer = scriptedPeer()
    const turns = hangingTurns(peer)
    peer.respond('turn/steer', () => ({ turnId: 'turn-1' }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.queueLocalCommand({ command: 'git status', stdout: 'clean', stderr: '', exitCode: 0 })
    runner.sendMessage('and now?')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(1))
    const input = (steers(peer)[0]!.params as { input: Array<{ type: string; text: string }> }).input
    expect(input).toHaveLength(2)
    expect(input[0]!.text).toContain('<local-command-stdout>$ git status\nclean</local-command-stdout>')
    expect(input[1]).toEqual({ type: 'text', text: 'and now?' })

    runner.sendMessage('again')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(2))
    expect((steers(peer)[1]!.params as { input: unknown[] }).input).toEqual([{ type: 'text', text: 'again' }])
    turns.complete('turn-1')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
  })

  it('re-runs a message whose steer died with the child, on the respawned child', async () => {
    const peer = scriptedPeer()
    const turns = hangingTurns(peer)
    peer.respond('turn/steer', () => {
      peer.die('codex app-server exited (code 1): boom')
      throw new Error('codex app-server exited (code 1): boom (awaiting turn/steer)')
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))

    runner.sendMessage('survivor')
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(2))
    expect(starts(peer)[1]).toMatchObject({ connection: 2, params: { threadId: 'thread-1', input: [{ type: 'text', text: 'survivor' }] } })
    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toMatchObject([{ connection: 2, params: { threadId: 'thread-1' } }])
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'error_during_execution' })
    turns.complete('turn-2')
    await vi.waitFor(() => expect(runner.status).toBe('idle'))
    expect(ofType(events, 'turn_result')).toHaveLength(2)
    expect(userTexts(events)).toEqual(['first', 'survivor'])
  })

  it('a steer still in flight when the session closes is dropped, not queued', async () => {
    const peer = scriptedPeer()
    hangingTurns(peer)
    let reject!: (error: Error) => void
    peer.respond(
      'turn/steer',
      () =>
        new Promise((_resolve, rejectSteer) => {
          reject = rejectSteer
        }),
    )
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    void runner.start()
    await vi.waitFor(() => expect(starts(peer)).toHaveLength(1))
    runner.sendMessage('doomed')
    await vi.waitFor(() => expect(steers(peer)).toHaveLength(1))

    runner.close()
    reject(new Error('codex app-server connection closed (awaiting turn/steer)'))
    await settle()
    expect(starts(peer)).toHaveLength(1)
    expect(runner.status).toBe('closed')
  })
})
