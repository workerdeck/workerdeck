import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { THREAD_RESULT, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

function toolUses(events: SessionEvent[]) {
  return ofType(events, 'assistant_message').flatMap((e) =>
    (Array.isArray(e.message.content) ? e.message.content : [])
      .filter((c): c is ToolUseBlock => (c as { type?: string }).type === 'tool_use')
      .map((block) => ({ block, parent: e.parentToolUseId ?? null, seq: e.seq })),
  )
}

function deltas(events: SessionEvent[]) {
  return ofType(events, 'stream_delta').map((e) => {
    const delta = (e.event as { delta?: { text?: string; thinking?: string } }).delta
    return { text: delta?.text ?? delta?.thinking ?? '', parent: e.parentToolUseId ?? null }
  })
}

function spawnItem(call: string, thread: string, path: string) {
  return {
    id: call,
    type: 'subAgentActivity',
    kind: 'started',
    agentThreadId: thread,
    agentPath: path,
  }
}

describe('CodexRunner sub-agents', () => {
  it("attributes two concurrent agents' interleaved work — deltas included — each to its own anchor", async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      const root = { threadId: 'thread-1', turnId }
      emit('item/completed', { ...root, item: spawnItem('call_a', 'thread-a', '/root/alpha') })
      emit('item/completed', { ...root, item: spawnItem('call_b', 'thread-b', '/root/beta') })
      emit('item/agentMessage/delta', { ...root, itemId: 'm-r', delta: 'root ' })
      emit('item/agentMessage/delta', { threadId: 'thread-a', turnId: 'turn-a', itemId: 'm-a', delta: 'alpha ' })
      emit('item/agentMessage/delta', { threadId: 'thread-b', turnId: 'turn-b', itemId: 'm-b', delta: 'beta ' })
      emit('item/agentMessage/delta', { threadId: 'thread-a', turnId: 'turn-a', itemId: 'm-a', delta: 'two' })
      emit('item/reasoning/summaryTextDelta', {
        threadId: 'thread-b',
        turnId: 'turn-b',
        itemId: 'rs-b',
        summaryIndex: 0,
        delta: 'weighing',
      })
      emit('item/started', {
        threadId: 'thread-a',
        turnId: 'turn-a',
        item: { id: 'exec-a', type: 'commandExecution', command: 'date', status: 'inProgress' },
      })
      emit('item/completed', {
        threadId: 'thread-a',
        turnId: 'turn-a',
        item: { id: 'exec-a', type: 'commandExecution', command: 'date', aggregatedOutput: 'Fri\n', exitCode: 0, status: 'completed' },
      })
      emit('item/completed', { ...root, item: { id: 'm-root', type: 'agentMessage', text: 'root answer' } })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'spawn two', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const anchors = toolUses(events).filter((t) => t.block.name === 'CodexAgent')
    expect(anchors).toHaveLength(2)
    const anchorA = anchors.find((t) => t.block.input.subagent_type === 'alpha')!
    const anchorB = anchors.find((t) => t.block.input.subagent_type === 'beta')!
    expect(anchorA.parent).toBeNull()
    expect(anchorB.parent).toBeNull()
    expect(anchorA.block.id.endsWith(':call_a')).toBe(true)
    expect(anchorA.block.input.agentThreadId).toBe('thread-a')

    expect(deltas(events)).toEqual([
      { text: 'root ', parent: null },
      { text: 'alpha ', parent: anchorA.block.id },
      { text: 'beta ', parent: anchorB.block.id },
      { text: 'two', parent: anchorA.block.id },
      { text: 'weighing', parent: anchorB.block.id },
    ])

    const exec = toolUses(events).find((t) => t.block.name === 'CodexCommand')!
    expect(exec.parent).toBe(anchorA.block.id)
    const execResult = ofType(events, 'user_message').find((e) => {
      const content = e.message.content
      return Array.isArray(content) && (content[0] as { tool_use_id?: string }).tool_use_id === exec.block.id
    })!
    expect(execResult.parentToolUseId).toBe(anchorA.block.id)

    const results = ofType(events, 'turn_result')
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toBe('root answer')

    expect(runner.info().subagents).toMatchObject([
      { toolUseId: anchorA.block.id, agentType: 'alpha', status: 'running', toolCount: 1 },
      { toolUseId: anchorB.block.id, agentType: 'beta', status: 'running', toolCount: 0 },
    ])
  })

  it("an agent's own turn/completed settles it — report as the anchor's result — while the root turn continues", async () => {
    const peer = scriptedPeer()
    let runner: CodexRunner | undefined
    let mid: unknown
    scriptTurn(peer, (emit, turnId) => {
      const root = { threadId: 'thread-1', turnId }
      emit('item/completed', { ...root, item: spawnItem('call_a', 'thread-a', '/root/alpha') })
      emit('item/completed', { ...root, item: spawnItem('call_b', 'thread-b', '/root/beta') })
      emit('item/started', {
        ...root,
        item: { id: 'call_w', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress', receiverThreadIds: [], agentsStates: {} },
      })
      emit('turn/completed', {
        threadId: 'thread-a',
        turn: { id: 'turn-a', status: 'completed', items: [{ id: 'm-final', type: 'agentMessage', text: 'alpha: Fri Aug 21' }] },
      })
      emit('turn/completed', {
        threadId: 'thread-b',
        turn: { id: 'turn-b', status: 'failed', error: { message: 'model refused' } },
      })
      mid = runner!.info().subagents
      emit('item/completed', {
        ...root,
        item: { id: 'call_w', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: [], agentsStates: {} },
      })
      emit('item/completed', { ...root, item: { id: 'm-root', type: 'agentMessage', text: 'both done' } })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    runner = new CodexRunner({ cwd: '/tmp', prompt: 'spawn two', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    expect(mid).toMatchObject([
      { agentType: 'alpha', status: 'done' },
      { agentType: 'beta', status: 'failed' },
    ])

    const anchors = toolUses(events).filter((t) => t.block.name === 'CodexAgent')
    const anchorA = anchors.find((t) => t.block.input.subagent_type === 'alpha')!
    const anchorB = anchors.find((t) => t.block.input.subagent_type === 'beta')!
    const resultFor = (id: string) =>
      ofType(events, 'user_message').find((e) => {
        const content = e.message.content
        return Array.isArray(content) && (content[0] as { tool_use_id?: string }).tool_use_id === id
      })
    const reportA = resultFor(anchorA.block.id)!
    expect(reportA.parentToolUseId).toBeNull()
    expect((reportA.message.content as Array<{ content?: string; is_error?: boolean }>)[0]).toMatchObject({
      content: 'alpha: Fri Aug 21',
    })
    expect((resultFor(anchorB.block.id)!.message.content as Array<{ content?: string; is_error?: boolean }>)[0]).toMatchObject({
      content: 'model refused',
      is_error: true,
    })

    const results = ofType(events, 'turn_result')
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toBe('both done')
    expect(reportA.seq).toBeLessThan(results[0]!.seq)

    const wait = toolUses(events).filter((t) => t.block.name === 'CodexCollab')
    expect(wait).toHaveLength(1)
    expect(wait[0]!.block.input).toEqual({ tool: 'wait' })
    expect(resultFor(wait[0]!.block.id)).toBeDefined()
  })

  it('a dying child settles the agents that lived in it', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', { threadId: 'thread-1', turnId, item: spawnItem('call_a', 'thread-a', '/root/alpha') })
      emit('item/completed', { threadId: 'thread-1', turnId, item: { id: 'm-root', type: 'agentMessage', text: 'spawned' } })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'spawn', connectFn: peer.connectFn })
    collect(runner)
    await runner.start()
    expect(runner.info().subagents).toMatchObject([{ status: 'running' }])
    peer.die('codex app-server exited (code 1): gone')
    expect(runner.info().subagents).toMatchObject([{ status: 'failed' }])
  })

  it('work from a thread that was never announced still gets an anchor — label-less, but a frame', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/agentMessage/delta', { threadId: 'thread-x', turnId: 'turn-x', itemId: 'm-x', delta: 'stray' })
      emit('item/completed', { threadId: 'thread-x', turnId: 'turn-x', item: { id: 'm-x', type: 'agentMessage', text: 'stray' } })
      emit('item/completed', { threadId: 'thread-1', turnId, item: { id: 'm-root', type: 'agentMessage', text: 'root' } })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const anchor = toolUses(events).find((t) => t.block.name === 'CodexAgent')!
    expect(anchor.block.input).toEqual({ agentThreadId: 'thread-x' })
    expect(deltas(events)).toEqual([{ text: 'stray', parent: anchor.block.id }])
    expect(anchor.seq).toBeLessThan(ofType(events, 'stream_delta')[0]!.seq)
    expect(runner.info().subagents).toMatchObject([{ toolUseId: anchor.block.id, status: 'running' }])
    expect(runner.info().subagents![0]!.agentType).toBeUndefined()
  })

  it('replays a historical spawn as a closed row and lists nothing: history holds no verdicts', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-h',
            items: [
              { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'spawn an agent' }] },
              spawnItem('call_h', 'thread-h', '/root/hist'),
              { id: 'item-2', type: 'agentMessage', text: 'Done.' },
            ],
          },
        ],
      },
      turnsBackwardsCursor: null,
    }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const anchor = toolUses(events).find((t) => t.block.name === 'CodexAgent')!
    expect(anchor.block.input.subagent_type).toBe('hist')
    const result = ofType(events, 'user_message').find((e) => {
      const content = e.message.content
      return Array.isArray(content) && (content[0] as { tool_use_id?: string }).tool_use_id === anchor.block.id
    })!
    expect(result.replay).toBe(true)
    expect((result.message.content as Array<{ is_error?: boolean }>)[0]!.is_error).toBeUndefined()
    expect(runner.info().subagents).toBeUndefined()
  })
})
