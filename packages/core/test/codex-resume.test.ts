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

  it('says so — visibly — when only a partial page could be loaded', async () => {
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

  it('backfillHistory: false keeps the old lazy promptless resume — no child, no replay', async () => {
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
