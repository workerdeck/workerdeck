import { describe, expect, it } from 'vitest'
import { contextReading, transcriptActivity, transcriptContent, transcriptProse, type SessionEventBody } from '@workerdeck/protocol'

describe('transcriptActivity', () => {
  const assistant = (content: unknown[]) =>
    ({
      type: 'assistant_message',
      message: { role: 'assistant', content },
      parentToolUseId: null,
      uuid: 'u1',
    }) as SessionEventBody

  it('counts one row per content block — five tool calls are five rows, not one message', () => {
    expect(
      transcriptActivity(
        assistant([
          { type: 'text', text: "I'll run five commands." },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't4', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't5', name: 'Bash', input: {} },
        ]),
      ),
    ).toBe(6)
  })

  it('counts a thinking block, and ignores tool results (they live in the call row)', () => {
    expect(transcriptActivity(assistant([{ type: 'thinking', thinking: 'hmm' }]))).toBe(1)
    expect(transcriptActivity(assistant([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]))).toBe(0)
  })

  it('treats a string body as the one row it renders as', () => {
    expect(transcriptActivity(assistant('plain text' as never))).toBe(1)
    expect(transcriptActivity(assistant('   ' as never))).toBe(0)
  })

  it('counts a typed user message but not the synthetic ones carrying tool results', () => {
    const user = (synthetic?: boolean): SessionEventBody => ({
      type: 'user_message',
      message: { role: 'user', content: 'hi' },
      parentToolUseId: null,
      synthetic,
    })
    expect(transcriptActivity(user())).toBe(1)
    expect(transcriptActivity(user(true))).toBe(0)
  })

  it('counts the rows that stand alone, and nothing that is merely state', () => {
    expect(
      transcriptActivity({
        type: 'turn_result',
        subtype: 'success',
        isError: false,
        durationMs: 1,
        durationApiMs: 1,
        numTurns: 1,
        totalCostUsd: 0,
      } as SessionEventBody),
    ).toBe(1)
    expect(transcriptActivity({ type: 'session_error', message: 'boom' })).toBe(1)
    expect(
      transcriptActivity({
        type: 'stream_delta',
        event: { type: 'content_block_delta' },
        parentToolUseId: null,
        uuid: 'u2',
      }),
    ).toBe(0)
    expect(transcriptActivity({ type: 'status_changed', status: 'running' })).toBe(0)
    expect(
      transcriptActivity({
        type: 'permission_resolved',
        requestId: 'p1',
        behavior: 'allow',
        resolvedBy: 'client',
      } as SessionEventBody),
    ).toBe(0)
    expect(transcriptActivity({ type: 'conversation_reset' })).toBe(0)
  })

  it('scores a subagent’s own messages zero, however many rows they would be', () => {
    expect(
      transcriptActivity({
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching.' },
            { type: 'tool_use', id: 't1', name: 'Grep', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
        parentToolUseId: 'toolu_a',
        uuid: 'u9',
      } as SessionEventBody),
    ).toBe(0)
    expect(
      transcriptActivity({
        type: 'user_message',
        message: { role: 'user', content: 'Search the repo for X.' },
        parentToolUseId: 'toolu_a',
        uuid: 'u10',
      } as SessionEventBody),
    ).toBe(0)
    expect(
      transcriptActivity({
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'Task', input: {} }],
        },
        parentToolUseId: null,
        uuid: 'u11',
      } as SessionEventBody),
    ).toBe(1)
  })
})

describe('transcriptProse', () => {
  const assistant = (content: unknown[], parentToolUseId: string | null = null) =>
    ({
      type: 'assistant_message',
      message: { role: 'assistant', content },
      parentToolUseId,
      uuid: 'u1',
    }) as SessionEventBody

  const turnResult = (isError: boolean): SessionEventBody =>
    ({
      type: 'turn_result',
      subtype: isError ? 'error_during_execution' : 'success',
      isError,
      durationMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
    }) as SessionEventBody

  it('scores the paragraph and none of the work around it — the whole point of the badge', () => {
    const message = assistant([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
      { type: 'text', text: 'Done — the build passes.' },
    ])
    expect(transcriptActivity(message)).toBe(4)
    expect(transcriptProse(message)).toBe(1)
  })

  it('scores a tool-only turn zero, so a tool-looping session shows no badge at all', () => {
    expect(
      transcriptProse(
        assistant([
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ]),
      ),
    ).toBe(0)
    expect(transcriptProse(assistant([{ type: 'thinking', thinking: 'long and silent' }]))).toBe(0)
  })

  it('ignores whitespace-only text, in a block and as a string body alike', () => {
    expect(transcriptProse(assistant([{ type: 'text', text: '   ' }]))).toBe(0)
    expect(transcriptProse(assistant('plain text' as never))).toBe(1)
    expect(transcriptProse(assistant('  ' as never))).toBe(0)
  })

  it('inherits the sub-agent carve-out: prose written to a parent is not addressed to the human', () => {
    expect(transcriptProse(assistant([{ type: 'text', text: 'Found it.' }], 'toolu_a'))).toBe(0)
  })

  it('counts a failed turn but not a successful one, which already carried its own prose', () => {
    expect(transcriptProse(turnResult(true))).toBe(1)
    expect(transcriptProse(turnResult(false))).toBe(0)
    expect(transcriptActivity(turnResult(false))).toBe(1)
  })

  it('counts the other things said to a human, and nothing that is merely work or state', () => {
    expect(transcriptProse({ type: 'session_error', message: 'boom' })).toBe(1)
    expect(transcriptProse({ type: 'file_delivered', path: '/tmp/x.png', bytes: 12 })).toBe(1)
    expect(
      transcriptProse({
        type: 'user_message',
        message: { role: 'user', content: 'hi' },
        parentToolUseId: null,
      }),
    ).toBe(1)
    expect(
      transcriptProse({
        type: 'user_message',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
        parentToolUseId: null,
        synthetic: true,
      }),
    ).toBe(0)
    expect(
      transcriptProse({
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
        parentToolUseId: null,
        uuid: 'u2',
      }),
    ).toBe(0)
    expect(transcriptProse({ type: 'status_changed', status: 'running' })).toBe(0)
    expect(transcriptProse({ type: 'conversation_reset' })).toBe(0)
  })
})

describe('transcriptContent', () => {
  it('classifies everything that mutates items as content, even at zero rows', () => {
    expect(
      transcriptContent({
        type: 'stream_delta',
        event: { type: 'content_block_delta' },
        parentToolUseId: null,
        uuid: 'u1',
      }),
    ).toBe(true)
    expect(
      transcriptContent({
        type: 'user_message',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
        parentToolUseId: null,
        synthetic: true,
      }),
    ).toBe(true)
    expect(
      transcriptContent({
        type: 'execution_result',
        executionId: 't1',
        output: { type: 'text', value: 'ok' },
      }),
    ).toBe(true)
    expect(transcriptContent({ type: 'conversation_reset' })).toBe(true)
  })

  it('classifies state a fresh attacher depends on as not-content', () => {
    expect(transcriptContent({ type: 'status_changed', status: 'idle' })).toBe(false)
    expect(transcriptContent({ type: 'capabilities', models: [], commands: [] })).toBe(false)
    expect(transcriptContent({ type: 'skills', skills: [] })).toBe(false)
    expect(transcriptContent({ type: 'model_changed', model: 'opus' })).toBe(false)
    expect(transcriptContent({ type: 'permission_mode_changed', mode: 'default' })).toBe(false)
    expect(transcriptContent({ type: 'plan_info', subscriptionType: 'max' })).toBe(false)
    expect(transcriptContent({ type: 'file_produced', fileId: 'f1', path: '/tmp/x.png' })).toBe(false)
    expect(transcriptContent({ type: 'rate_limit', info: { status: 'allowed' } })).toBe(false)
    expect(
      transcriptContent({
        type: 'permission_requested',
        request: { id: 'p1', toolName: 'Bash', input: {}, toolUseId: 't1' },
      }),
    ).toBe(false)
    expect(transcriptContent({ type: 'sdk_event', payload: { type: 'x' } })).toBe(false)
  })
})

describe('contextReading', () => {
  const usage = {
    type: 'context_usage',
    usage: {
      categories: [{ name: 'system prompt', tokens: 1200, color: 'inactive' }],
      totalTokens: 142_000,
      maxTokens: 200_000,
      percentage: 71,
      model: 'claude-opus-4',
    },
  } as SessionEventBody

  it('keeps the three numbers a list row needs and drops the breakdown', () => {
    expect(contextReading(usage)).toEqual({
      totalTokens: 142_000,
      maxTokens: 200_000,
      percentage: 71,
    })
  })

  it('answers undefined for every other event, a reset included', () => {
    expect(contextReading({ type: 'conversation_reset' } as SessionEventBody)).toBeUndefined()
    expect(contextReading({ type: 'status_changed', status: 'idle' } as SessionEventBody)).toBeUndefined()
  })
})
