import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import { THREAD_RESULT, USAGE_A, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

describe('CodexRunner clearContext', () => {
  it('clears by starting a FRESH thread on the same session, not by resuming', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'call_spawn',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'thread-child',
          agentPath: '/root/luna_1',
        },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_A, total: USAGE_A, modelContextWindow: 1_000 },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    expect(runner.info().sdkSessionId).toBe('thread-1')
    expect(runner.info().contextUsage).toBeDefined()
    expect(runner.info().subagents).toBeDefined()

    await runner.clearContext()

    expect(peer.requests.filter((r) => r.method === 'thread/start')).toHaveLength(2)
    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0)
    const resets = ofType(events, 'conversation_reset')
    expect(resets).toHaveLength(1)
    expect(resets[0]!.sdkSessionId).toBe('thread-2')
    expect(runner.info().sdkSessionId).toBe('thread-2')
    expect(runner.info().contextUsage).toBeUndefined()
    expect(runner.info().subagents).toBeUndefined()
    expect(runner.info().activityCount).toBeGreaterThan(0)
  })

  it('intercepts a bare /clear prompt instead of sending it to the model', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    const turnsBefore = peer.requests.filter((r) => r.method === 'turn/start').length

    runner.sendMessage('  /clear  ')
    await runner.interrupt() // drains the turn chain the intercept rides

    expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(turnsBefore)
    expect(ofType(events, 'conversation_reset')).toHaveLength(1)
    expect(ofType(events, 'user_message').some((e) => e.message.content === '  /clear  ')).toBe(false)
  })

  it('treats /clear inside a longer prompt as an ordinary message', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    runner.sendMessage('explain what /clear does')
    await runner.interrupt()

    expect(ofType(events, 'conversation_reset')).toHaveLength(0)
    expect(ofType(events, 'user_message').some((e) => e.message.content === 'explain what /clear does')).toBe(true)
  })

  it('queues a clear behind the running turn, and keeps the message typed after it', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    const prompts: string[] = []
    let firstTurn: (() => void) | undefined
    peer.respond('turn/start', (params) => {
      const input = (params as { input: Array<{ text?: string }> }).input
      prompts.push(input.map((part) => part.text ?? '').join(''))
      const turnId = `turn-${prompts.length}`
      const threadId = (params as { threadId: string }).threadId
      peer.emit('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
      const finish = () => peer.emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
      if (prompts.length === 1) {
        firstTurn = finish
      } else {
        finish()
      }
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'first', connectFn: peer.connectFn })
    const events = collect(runner)
    const started = runner.start()
    await vi.waitFor(() => expect(firstTurn).toBeDefined())

    runner.sendMessage('/clear')
    runner.sendMessage('after the clear')
    expect(ofType(events, 'conversation_reset')).toHaveLength(0)
    expect(prompts).toEqual(['first'])

    firstTurn!()
    await started
    await vi.waitFor(() => expect(prompts).toHaveLength(2))

    expect(ofType(events, 'conversation_reset')).toHaveLength(1)
    expect(prompts[1]).toBe('after the clear')
    const second = peer.requests.find(
      (r) => r.method === 'turn/start' && (r.params as { input: Array<{ text?: string }> }).input[0]?.text === 'after the clear',
    )
    expect((second!.params as { threadId: string }).threadId).toBe('thread-2')
  })

  it('leaves the session on its old thread when the fresh thread/start fails', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => {
      if (++threads > 1) {
        throw new JsonRpcError(-32000, 'no')
      }
      return THREAD_RESULT
    })
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    await expect(runner.clearContext()).rejects.toThrow()

    expect(ofType(events, 'conversation_reset')).toHaveLength(0)
    expect(runner.info().sdkSessionId).toBe('thread-1')
  })

  it('does not replay the cleared conversation to a client that attaches after', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_old', type: 'agentMessage', text: 'from the cleared conversation' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    await runner.start()
    await runner.clearContext()

    const replayed: SessionEvent[] = []
    runner.subscribe((event) => replayed.push(event), 0)

    const texts = ofType(replayed, 'assistant_message')
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
    expect(texts).toEqual([])
    expect(ofType(replayed, 'user_message')).toHaveLength(0)
    expect(ofType(replayed, 'conversation_reset')).toHaveLength(1)
    expect(ofType(replayed, 'status_changed').length).toBeGreaterThan(0)
  })
})
