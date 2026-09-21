import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import { THREAD_RESULT, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

// Two historical turns whose item ids overlap on purpose: codex restarts item numbering per
// turn, so the per-turn nonce is what keeps them apart.
const HISTORY_TURNS = [
  {
    id: 'turn-h1',
    items: [
      {
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'make a file', text_elements: [] }],
      },
      { id: 'item-2', type: 'agentMessage', text: 'Making it.' },
      {
        id: 'item-3',
        type: 'commandExecution',
        command: 'touch x',
        aggregatedOutput: 'ok\n',
        exitCode: 0,
        status: 'completed',
      },
    ],
  },
  {
    id: 'turn-h2',
    items: [
      {
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'now delete it', text_elements: [] }],
      },
      { id: 'item-2', type: 'agentMessage', text: 'Deleted.' },
    ],
  },
]

describe('CodexRunner resume backfill', () => {
  it('replays a promptless resume: same item mapping, replay-flagged, one nonce per historical turn', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: HISTORY_TURNS },
      turnsBackwardsCursor: null,
    }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const messages = events.filter(
      (e): e is Extract<SessionEvent, { type: 'user_message' | 'assistant_message' }> =>
        e.type === 'user_message' || e.type === 'assistant_message',
    )
    const texts = messages.map((e) => {
      const content = e.message.content
      if (typeof content === 'string') {
        return content
      }
      const block = (content as Array<Record<string, unknown>>)[0]!
      return (block.text ?? block.content ?? block.name) as string
    })
    expect(texts).toEqual(['make a file', 'Making it.', 'CodexCommand', 'ok\n', 'now delete it', 'Deleted.'])
    expect(messages.every((e) => e.replay === true)).toBe(true)

    const uuidOf = (index: number) => messages[index]!.uuid as string
    const nonceOf = (index: number) => uuidOf(index).split(':')[0]!
    expect(uuidOf(0).endsWith(':item-1')).toBe(true)
    expect(uuidOf(4).endsWith(':item-1')).toBe(true)
    expect(uuidOf(0)).not.toBe(uuidOf(4))
    expect(nonceOf(0)).toBe(nonceOf(1)) // one namespace within a turn…
    expect(nonceOf(0)).not.toBe(nonceOf(4)) // …a fresh one for the next

    const toolUse = messages[2]!.message.content as Array<{ type: string; id: string }>
    const toolResult = messages[3]!.message.content as Array<{ type: string; tool_use_id: string }>
    expect(toolResult[0]!.tool_use_id).toBe(toolUse[0]!.id)

    expect(peer.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'thread/resume', 'skills/list'])
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(events.some((e) => e.type === 'turn_result')).toBe(false)
    expect(runner.status).toBe('idle')
  })

  it('replays an image-only prompt as a named picture, not as a missing turn', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-h1',
            items: [
              {
                id: 'item-1',
                type: 'userMessage',
                content: [
                  { type: 'image', imageUrl: 'data:…' },
                  { type: 'localImage', path: '/x' },
                ],
              },
              { id: 'item-2', type: 'agentMessage', text: 'Two pictures.' },
            ],
          },
        ],
      },
      turnsBackwardsCursor: null,
    }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const user = events.find((e): e is Extract<SessionEvent, { type: 'user_message' }> => e.type === 'user_message')
    expect(user?.message.content).toBe('[2 images]')
  })

  it('resume with a prompt: history lands before the new turn, once, with disjoint live ids', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: null,
    }))
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item-2', type: 'agentMessage', text: 'Live answer.' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'continue',
      resume: 'prior',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()

    const messages = events.filter(
      (e): e is Extract<SessionEvent, { type: 'user_message' | 'assistant_message' }> =>
        e.type === 'user_message' || e.type === 'assistant_message',
    )
    const texts = messages.map((e) =>
      typeof e.message.content === 'string' ? e.message.content : ((e.message.content as Array<{ text?: string }>)[0]!.text ?? ''),
    )
    expect(texts).toEqual(['now delete it', 'Deleted.', 'continue', 'Live answer.'])
    expect(messages.map((e) => e.replay === true)).toEqual([true, true, false, false])
    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(1)
    expect(texts.filter((t) => t === 'Deleted.')).toHaveLength(1)
    expect(messages[1]!.uuid!.endsWith(':item-2')).toBe(true)
    expect(messages[3]!.uuid!.endsWith(':item-2')).toBe(true)
    expect(messages[1]!.uuid).not.toBe(messages[3]!.uuid)
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success', result: 'Live answer.' })
  })

  it('pages a partial resume through thread/read, so the replay is the whole rollout', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: 'older-turns-exist',
    }))
    peer.respond('thread/read', () => ({ thread: { id: 'thread-1', turns: HISTORY_TURNS } }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    expect(peer.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'thread/resume', 'skills/list', 'thread/read'])
    expect(peer.requests[4]).toMatchObject({
      params: { threadId: 'thread-1', includeTurns: true },
    })
    const users = ofType(events, 'user_message').filter((e) => !e.synthetic)
    expect(users.map((e) => e.message.content)).toEqual(['make a file', 'now delete it'])
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('says so - visibly - when only a partial page could be loaded', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: 'older-turns-exist',
    }))
    peer.respond('thread/read', () => {
      throw new JsonRpcError(-32601, 'no thread/read here')
    })
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const errorIndex = events.findIndex((e) => e.type === 'session_error')
    const firstReplay = events.findIndex((e) => (e.type === 'user_message' || e.type === 'assistant_message') && e.replay)
    expect(errorIndex).toBeGreaterThanOrEqual(0)
    expect(events[errorIndex]).toMatchObject({
      message: expect.stringContaining('incomplete'),
    })
    expect(firstReplay).toBeGreaterThan(errorIndex)
    const users = ofType(events, 'user_message').filter((e) => !e.synthetic)
    expect(users.map((e) => e.message.content)).toEqual(['now delete it'])
    expect(runner.status).toBe('idle')
  })

  it('backfillHistory: false keeps the old lazy promptless resume - no child, no replay', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: HISTORY_TURNS },
    }))
    const runner = new CodexRunner({
      cwd: '/tmp',
      resume: 'prior',
      backfillHistory: false,
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(peer.connections()).toBe(0)
    expect(events.some((e) => e.type === 'user_message' || e.type === 'assistant_message')).toBe(false)
    expect(runner.status).toBe('idle')
  })

  it('a reconnect after a dead child resumes the thread but never replays twice', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: null,
    }))
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'a1', type: 'agentMessage', text: 'done' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    const replayCount = () => events.filter((e) => (e.type === 'user_message' || e.type === 'assistant_message') && e.replay).length
    expect(replayCount()).toBe(2)

    peer.die('codex app-server exited (code 1): gone')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(1))
    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(2)
    expect(replayCount()).toBe(2)
  })
})

// Codex writes a thread's rollout on its first turn, not on `thread/start`; an id with no turn behind it resumes nothing.
function scriptTurnOnRequestedThread(peer: ReturnType<typeof scriptedPeer>, reply = 'done') {
  let turns = 0
  peer.respond('turn/start', (params) => {
    const threadId = (params as { threadId: string }).threadId
    const turnId = `turn-${++turns}`
    peer.emit('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
    peer.emit('item/completed', { threadId, turnId, item: { id: 'item-1', type: 'agentMessage', text: reply } })
    peer.emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
    return { turn: { id: turnId, status: 'inProgress' } }
  })
}

describe('CodexRunner thread materialization', () => {
  it('names no thread until a turn reaches codex, and names it from turn/started on', async () => {
    const peer = scriptedPeer()
    let finish: (() => void) | undefined
    peer.respond('turn/start', (params) => {
      const threadId = (params as { threadId: string }).threadId
      finish = () => {
        peer.emit('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress' } })
        peer.emit('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } })
      }
      return { turn: { id: 'turn-1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const started = runner.start()
    await vi.waitFor(() => expect(finish).toBeDefined())

    expect(peer.requests.some((r) => r.method === 'thread/start')).toBe(true)
    expect(runner.sdkSessionId).toBeUndefined()
    expect(runner.info().sdkSessionId).toBeUndefined()

    finish!()
    await started
    expect(runner.sdkSessionId).toBe('thread-1')
    expect(runner.info().sdkSessionId).toBe('thread-1')
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success' })
  })

  it('a thread whose first turn never reached codex is started over after a dead child, never resumed', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    let rejectOnce = true
    peer.respond('turn/start', (params) => {
      if (rejectOnce) {
        rejectOnce = false
        throw new JsonRpcError(-32000, 'model unavailable')
      }
      const threadId = (params as { threadId: string }).threadId
      peer.emit('turn/started', { threadId, turn: { id: 'turn-2', status: 'inProgress' } })
      peer.emit('turn/completed', { threadId, turn: { id: 'turn-2', status: 'completed' } })
      return { turn: { id: 'turn-2', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'error_during_execution', errors: ['model unavailable'] })
    expect(runner.info().sdkSessionId).toBeUndefined()

    peer.die('codex app-server exited (code 1): gone')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))

    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0)
    expect(peer.requests.filter((r) => r.method === 'thread/start')).toHaveLength(2)
    const second = peer.requests.filter((r) => r.method === 'turn/start')[1]!
    expect((second.params as { threadId: string }).threadId).toBe('thread-2')
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success' })
    expect(runner.info().sdkSessionId).toBe('thread-2')
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('a resumed id names the thread at once, so a wake before any new turn still persists it', async () => {
    const peer = scriptedPeer()
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', backfillHistory: false, connectFn: peer.connectFn })
    await runner.start()
    expect(runner.info().sdkSessionId).toBe('prior')
  })

  it('a wake whose rollout is gone starts a fresh thread with the same options, says so once, and keeps working', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => {
      throw new JsonRpcError(-32600, 'no rollout found for thread id prior')
    })
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: 'thread-fresh' } }))
    scriptTurnOnRequestedThread(peer, 'fresh answer')
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    expect(peer.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'thread/resume', 'thread/start', 'skills/list'])
    const { threadId, ...resumeOptions } = peer.requests[2]!.params as Record<string, unknown>
    expect(threadId).toBe('prior')
    expect(peer.requests[3]!.params).toEqual(resumeOptions)
    const notices = ofType(events, 'session_error')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain('prior')
    expect(notices[0]!.message).toMatch(/new thread/)
    expect(events.some((e) => e.type === 'user_message' || e.type === 'assistant_message')).toBe(false)
    expect(events.some((e) => e.type === 'turn_result')).toBe(false)
    expect(runner.status).toBe('idle')
    expect(runner.info().sdkSessionId).toBeUndefined()

    runner.sendMessage('hello again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(1))
    const turn = peer.requests.find((r) => r.method === 'turn/start')!
    expect((turn.params as { threadId: string }).threadId).toBe('thread-fresh')
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success', result: 'fresh answer' })
    expect(ofType(events, 'session_error')).toHaveLength(1)
    expect(runner.info().sdkSessionId).toBe('thread-fresh')
    const echo = events.findIndex((e) => e.type === 'user_message')
    expect(echo).toBeGreaterThan(events.indexOf(notices[0]!))
  })

  it('a wake with a prompt heals the same way, with the notice ahead of the new turn', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => {
      throw new JsonRpcError(-32600, 'no rollout found for thread id prior')
    })
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: 'thread-fresh' } }))
    scriptTurnOnRequestedThread(peer)
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', prompt: 'continue', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const types = events.map((e) => e.type)
    expect(types.indexOf('session_error')).toBeLessThan(types.indexOf('user_message'))
    expect(ofType(events, 'session_error')).toHaveLength(1)
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success' })
    expect((peer.requests.find((r) => r.method === 'turn/start')!.params as { threadId: string }).threadId).toBe('thread-fresh')
  })

  it('any other resume rejection still fails the turn, and never starts a thread behind the user', async () => {
    for (const rejection of [
      new JsonRpcError(-32600, 'invalid params: unknown field `sandbox`'),
      new JsonRpcError(-32000, 'no rollout found for thread id prior'),
    ]) {
      const peer = scriptedPeer()
      peer.respond('thread/resume', () => {
        throw rejection
      })
      const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', prompt: 'continue', connectFn: peer.connectFn })
      const events = collect(runner)
      await runner.start()

      expect(peer.requests.some((r) => r.method === 'thread/start')).toBe(false)
      expect(ofType(events, 'session_error')).toHaveLength(0)
      expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'error_during_execution', errors: [rejection.message] })
      expect(runner.info().sdkSessionId).toBe('prior')
      expect(runner.status).toBe('idle')
    }
  })
})
