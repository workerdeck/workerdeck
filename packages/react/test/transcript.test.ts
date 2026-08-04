import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import {
  applyEvent,
  initialTranscriptState,
  seedFromSessionInfo,
  type TranscriptState,
} from '../src/transcript.ts'

let seq = 0
const ev = (body: SessionEventBody): SessionEvent => ({ ...body, seq: ++seq, ts: 0 })

function run(state: TranscriptState, bodies: SessionEventBody[]): TranscriptState {
  return bodies.reduce((s, body) => applyEvent(s, ev(body)), state)
}

describe('transcript reducer', () => {
  it('builds a transcript from a full turn', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'system_init',
        sdkSessionId: 'sdk-1',
        model: 'claude-test-1',
        cwd: '/tmp/p',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: '2.0.0',
        mcpServers: [],
      },
      { type: 'status_changed', status: 'running' },
      { type: 'user_message', message: { role: 'user', content: 'run ls' }, parentToolUseId: null, uuid: 'u1' },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Sure, ' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'running.' } },
        parentToolUseId: null,
        uuid: 's2',
      },
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, running.' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        parentToolUseId: null,
        uuid: 'a1',
      },
      {
        type: 'user_message',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file.txt' }],
        },
        parentToolUseId: null,
        synthetic: true,
        uuid: 'u2',
      },
      {
        type: 'turn_result',
        subtype: 'success',
        isError: false,
        durationMs: 900,
        numTurns: 1,
        totalCostUsd: 0.02,
        result: 'done',
      },
    ])

    expect(state.model).toBe('claude-test-1')
    expect(state.status).toBe('running')
    expect(state.totalCostUsd).toBeCloseTo(0.02)
    const kinds = state.items.map((i) => i.kind)
    expect(kinds).toEqual(['user', 'assistant_text', 'tool_call', 'turn_result'])
    const tool = state.items.find((i) => i.kind === 'tool_call')
    expect(tool).toMatchObject({ name: 'Bash', result: { text: 'file.txt', isError: false } })
    // streamed text was replaced by the final message
    const texts = state.items.filter((i) => i.kind === 'assistant_text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'Sure, running.', streaming: false })
  })

  it('accumulates stream deltas into one streaming item', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } },
        parentToolUseId: null,
        uuid: 's2',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'assistant_text', id: 'streaming', text: 'ab', streaming: true, parentToolUseId: null },
    ])
  })

  it('tracks pending approvals and ignores duplicate seq', () => {
    seq = 0
    const request = {
      id: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'tool-1',
    }
    const first = applyEvent(initialTranscriptState, ev({ type: 'permission_requested', request }))
    expect(first.pendingApprovals).toHaveLength(1)
    // replay of the same seq is a no-op
    expect(applyEvent(first, { type: 'permission_requested', request, seq: 1, ts: 0 })).toBe(first)
    const resolved = applyEvent(
      first,
      ev({ type: 'permission_resolved', requestId: 'req-1', behavior: 'deny', resolvedBy: 'timeout' }),
    )
    expect(resolved.pendingApprovals).toHaveLength(0)
  })

  it('accumulates thinking deltas and supersedes them with the full message', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm, ' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ok.' } },
        parentToolUseId: null,
        uuid: 's2',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'thinking', id: 'streaming-thinking', text: 'Hmm, ok.', parentToolUseId: null },
    ])

    const done = applyEvent(
      state,
      ev({
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hmm, ok.' }] },
        parentToolUseId: null,
        uuid: 'a1',
      }),
    )
    expect(done.items).toHaveLength(1)
    expect(done.items[0]).toMatchObject({ kind: 'thinking', id: 'a1-0', text: 'Hmm, ok.' })
  })

  it('keeps streamed thinking when the full message ships a signature-only block', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Weighing it.' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'assistant_message',
        // Encrypted thinking: text stripped, signature only.
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'Eu8E' }] },
        parentToolUseId: null,
        uuid: 'a1',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'thinking', id: 'a1-0', text: 'Weighing it.', parentToolUseId: null },
    ])
  })

  it('drops thinking blocks that carry no summary at all', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'Eu8E' }] },
        parentToolUseId: null,
        uuid: 'a1',
      },
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'EpIC' }] },
        parentToolUseId: null,
        uuid: 'a2',
      },
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        parentToolUseId: null,
        uuid: 'a3',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'assistant_text', id: 'a3-0', text: 'Done.', streaming: false, parentToolUseId: null },
    ])
  })

  it('treats turn_result cost as session-cumulative (last-seen, not summed)', () => {
    seq = 0
    const turn = (totalCostUsd: number): SessionEventBody => ({
      type: 'turn_result',
      subtype: 'success',
      isError: false,
      durationMs: 100,
      numTurns: 1,
      totalCostUsd,
      result: 'ok',
    })
    const state = run(initialTranscriptState, [turn(0.02), turn(0.05)])
    expect(state.totalCostUsd).toBeCloseTo(0.05)
  })

  it('dedupes backfilled history against SDK-replayed user messages by uuid', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      // backfill copy (from getSessionMessages)
      {
        type: 'user_message',
        message: { role: 'user', content: 'earlier prompt' },
        parentToolUseId: null,
        replay: true,
        uuid: 'u-hist-1',
      },
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
        parentToolUseId: null,
        replay: true,
        uuid: 'a-hist-1',
      },
      // SDK's own replay of the same user message on resume
      {
        type: 'user_message',
        message: { role: 'user', content: 'earlier prompt' },
        parentToolUseId: null,
        replay: true,
        uuid: 'u-hist-1',
      },
    ])
    expect(state.items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(state.items.map((i) => i.kind)).toEqual(['user', 'assistant_text'])
  })

  it('renders a delivered file as a download card item', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      { type: 'file_delivered', path: '/SUMMARY.md', bytes: 42, description: 'the summary' },
    ])
    expect(state.items).toEqual([
      {
        kind: 'file_delivered',
        id: 'file-1',
        path: '/SUMMARY.md',
        bytes: 42,
        description: 'the summary',
      },
    ])
  })

  it('renders local-command output as a notice, not a user bubble', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'user_message',
        message: {
          role: 'user',
          content: '<local-command-stdout>Set model to sonnet</local-command-stdout>',
        },
        parentToolUseId: null,
        uuid: 'lc-1',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'notice', id: 'lc-1', level: 'info', text: 'Set model to sonnet' },
    ])
  })

  it('tracks capabilities and model changes', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'capabilities',
        models: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }],
        commands: [{ name: 'compact', description: 'Compact the conversation' }],
      },
      { type: 'model_changed', model: 'claude-opus-4-8' },
    ])
    expect(state.models).toEqual([{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }])
    expect(state.commands?.map((c) => c.name)).toEqual(['compact'])
    expect(state.model).toBe('claude-opus-4-8')

    // reset-to-default keeps showing the last known model
    const after = applyEvent(state, ev({ type: 'model_changed', model: undefined }))
    expect(after.model).toBe('claude-opus-4-8')
  })

  it('seeds permissionMode from system_init and follows permission_mode_changed', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'system_init',
        sdkSessionId: 'sdk-1',
        model: 'claude-test-1',
        cwd: '/tmp/p',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: '2.0.0',
        mcpServers: [],
      },
    ])
    expect(state.permissionMode).toBe('default')
    const switched = applyEvent(state, ev({ type: 'permission_mode_changed', mode: 'acceptEdits' }))
    expect(switched.permissionMode).toBe('acceptEdits')
  })

  it('tracks context usage and per-window rate limits', () => {
    seq = 0
    const usage = {
      categories: [{ name: 'System prompt', tokens: 3000, color: '#888' }],
      totalTokens: 42_000,
      maxTokens: 200_000,
      percentage: 21,
      model: 'claude-test-1',
    }
    const state = run(initialTranscriptState, [
      { type: 'context_usage', usage },
      {
        type: 'rate_limit',
        info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 30, resetsAt: 1_800_000_000 },
      },
      {
        type: 'rate_limit',
        info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 23, resetsAt: 1_800_500_000 },
      },
      // a second five_hour update replaces only its own window
      {
        type: 'rate_limit',
        info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 85, resetsAt: 1_800_000_000 },
      },
      // no window key → ignored rather than stored under a bogus key
      { type: 'rate_limit', info: { status: 'allowed' } },
    ])
    expect(state.contextUsage).toEqual(usage)
    expect(state.rateLimits?.five_hour).toMatchObject({ utilization: 85, status: 'allowed_warning' })
    expect(state.rateLimits?.seven_day).toMatchObject({ utilization: 23 })
    expect(Object.keys(state.rateLimits ?? {})).toHaveLength(2)
  })

  it('seeds from the attach snapshot without overriding event-derived state', () => {
    seq = 0
    const info: SessionInfo = {
      id: 'srv-1',
      status: 'idle',
      cwd: '/tmp/p',
      engine: 'provider',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      createdAt: 0,
      lastSeq: 0,
      pendingPermissionCount: 0,
    }
    // promptless session: no events yet — snapshot fills everything
    const seeded = seedFromSessionInfo(initialTranscriptState, info)
    expect(seeded).toMatchObject({
      status: 'idle',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      cwd: '/tmp/p',
      // No event carries the engine — the snapshot is its only source, and
      // surfaces gate CLI-only affordances on it.
      engine: 'provider',
    })

    // after events have arrived, the event stream stays authoritative
    const live = run(seeded, [
      {
        type: 'system_init',
        sdkSessionId: 'sdk-1',
        model: 'claude-sonnet-4-6',
        cwd: '/tmp/p',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: '2.0.0',
        mcpServers: [],
      },
      { type: 'status_changed', status: 'running' },
    ])
    const reseeded = seedFromSessionInfo(live, info)
    expect(reseeded.status).toBe('running')
    expect(reseeded.model).toBe('claude-sonnet-4-6')
    expect(reseeded.permissionMode).toBe('default')
  })

  describe('tool-call execution states', () => {
    const toolUse = (id: string): SessionEventBody => ({
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'eval_script', input: { script: '1+1' } }] },
      parentToolUseId: null,
      uuid: `a-${id}`,
    })
    const call = (state: TranscriptState) => state.items.find((i) => i.kind === 'tool_call')

    it('starts a tool call as running', () => {
      seq = 0
      const state = run(initialTranscriptState, [toolUse('t1')])
      expect(call(state)).toMatchObject({ status: 'running' })
      expect(call(state)).not.toHaveProperty('result.text')
    })

    it('moves to pending when dispatched, then settles with the result', () => {
      seq = 0
      const dispatched = run(initialTranscriptState, [
        toolUse('t1'),
        { type: 'execution_dispatched', executionId: 't1', toolName: 'eval_script', backend: 'browser' },
      ])
      expect(call(dispatched)).toMatchObject({ status: 'pending', backend: 'browser', executionId: 't1' })

      const settled = run(dispatched, [
        { type: 'execution_result', executionId: 't1', output: { type: 'json', value: { n: 2 } }, logs: ['[log] hi'] },
      ])
      expect(call(settled)).toMatchObject({
        status: 'settled',
        result: { text: '{"n":2}', isError: false },
        logs: ['[log] hi'],
      })
    })

    it('marks a deferred dispatch distinctly from a pending one', () => {
      seq = 0
      const state = run(initialTranscriptState, [
        toolUse('t1'),
        { type: 'execution_dispatched', executionId: 't1', toolName: 'eval_script', backend: 'remote', deferred: true },
      ])
      expect(call(state)).toMatchObject({ status: 'deferred', backend: 'remote' })
    })

    it('renders an execution failure as a failed call carrying the reason', () => {
      seq = 0
      const state = run(initialTranscriptState, [
        toolUse('t1'),
        { type: 'execution_dispatched', executionId: 't1', toolName: 'eval_script', backend: 'browser' },
        { type: 'execution_failed', executionId: 't1', reason: 'timeout', error: 'guest exceeded its deadline' },
      ])
      expect(call(state)).toMatchObject({
        status: 'failed',
        result: { text: 'timeout: guest exceeded its deadline', isError: true },
      })
    })

    it('settles via a tool_result block too (the Claude engine path)', () => {
      seq = 0
      const ok = run(initialTranscriptState, [
        toolUse('t1'),
        {
          type: 'user_message',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
          parentToolUseId: null,
          synthetic: true,
          uuid: 'r1',
        },
      ])
      expect(call(ok)).toMatchObject({ status: 'settled', result: { text: 'done', isError: false } })

      seq = 0
      const failed = run(initialTranscriptState, [
        toolUse('t2'),
        {
          type: 'user_message',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'nope', is_error: true }] },
          parentToolUseId: null,
          synthetic: true,
          uuid: 'r2',
        },
      ])
      expect(call(failed)).toMatchObject({ status: 'failed', result: { isError: true } })
    })

    it('ignores execution events for an unknown id instead of inventing an item', () => {
      seq = 0
      const state = run(initialTranscriptState, [
        { type: 'execution_result', executionId: 'ghost', output: { type: 'text', value: 'x' } },
      ])
      expect(state.items).toHaveLength(0)
    })
  })
})
