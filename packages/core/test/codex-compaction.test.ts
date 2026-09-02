import { describe, expect, it } from 'vitest'
import { transcriptActivity, transcriptContent, transcriptProse } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { THREAD_RESULT, USAGE_A, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

// The `contextCompaction` item is `{id, type}` and nothing more — checked against 0.151.0's
// generated schema. Before it was mapped it fell through to `sdk_event`, which no client renders,
// so a compaction was a silent hole in the transcript.
function compactionItem(id = 'compact-1') {
  return { id, type: 'contextCompaction' }
}

describe('CodexRunner context compaction', () => {
  it('turns the item into a `context_compacted` event rather than an unrendered sdk_event', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      const root = { threadId: 'thread-1', turnId }
      emit('item/completed', { ...root, item: compactionItem() })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const compactions = ofType(events, 'context_compacted')
    expect(compactions).toHaveLength(1)
    expect(compactions[0]!.parentToolUseId).toBeNull()
    // The whole point: it must not land on the channel nothing draws.
    expect(ofType(events, 'sdk_event').filter((e) => e.payload.type === 'codex.contextCompaction')).toHaveLength(0)
  })

  it('does NOT empty the transcript — a compaction preserves what a reset discards', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    scriptTurn(peer, (emit, turnId) => {
      const root = { threadId: 'thread-1', turnId }
      emit('item/completed', { ...root, item: { id: 'm-1', type: 'agentMessage', text: 'before' } })
      emit('item/completed', { ...root, item: compactionItem() })
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

    // No reset was emitted, the session id did not move, and the reading the engine reported after
    // compacting stands — the runner must not invent a post-compaction occupancy of its own.
    expect(ofType(events, 'conversation_reset')).toHaveLength(0)
    expect(runner.info().sdkSessionId).toBe('thread-1')
    expect(runner.info().contextUsage).toBeDefined()
    // The message that preceded the compaction is still in the stream.
    expect(ofType(events, 'assistant_message')).toHaveLength(1)
  })

  it('attributes a sub-agent’s compaction to that agent, so the row nests where its work does', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'call_spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'thread-a', agentPath: '/root/alpha' },
      })
      emit('item/completed', { threadId: 'thread-a', turnId: 'turn-a', item: compactionItem('compact-a') })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const compactions = ofType(events, 'context_compacted')
    expect(compactions).toHaveLength(1)
    expect(compactions[0]!.parentToolUseId).not.toBeNull()
  })

  it('is a transcript row that scores no unread — it is not addressed to the human', () => {
    const body = { type: 'context_compacted', uuid: 'x' } as const
    expect(transcriptContent(body)).toBe(true)
    // A compaction is the engine housekeeping, not news. Counting it would put a badge on a
    // session nobody needs to open, and tick the dormancy/sort measure for the same non-event.
    expect(transcriptActivity(body)).toBe(0)
    expect(transcriptProse(body)).toBe(0)
  })
})
