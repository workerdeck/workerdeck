import { describe, expect, it } from 'vitest'
import {
  transcriptActivity,
  transcriptContent,
  type SessionEventBody,
} from '@workerdeck/protocol'

/**
 * `activityCount` is what a client diffs to answer "how much happened while I
 * wasn't looking", so the unit has to be the one the reader sees: transcript
 * rows. These cases are the ones that made the old turn-based badge wrong — a
 * turn full of tool calls is one turn and many rows.
 */
describe('transcriptActivity', () => {
  const assistant = (content: SessionEventBody extends infer _ ? unknown[] : never) =>
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
    expect(
      transcriptActivity(assistant([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])),
    ).toBe(0)
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
    // Streamed tokens are the reason `lastSeq` cannot be used for this: hundreds
    // of events per reply, none of them a new row.
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
    // Not a row: a reset is what removes rows, and counting it would advance
    // the unread cursor for something nobody needs to read.
    expect(transcriptActivity({ type: 'conversation_reset' })).toBe(0)
  })
})

/**
 * The replay-filter rule behind `conversation_reset` — which events the runner
 * may skip below a reset because the reducer would have cleared them anyway.
 * Deliberately broader than `transcriptActivity() > 0`: what matters is whether
 * the reducer *mutates items*, not whether a row is added.
 */
describe('transcriptContent', () => {
  it('classifies everything that mutates items as content, even at zero rows', () => {
    // Zero activity, but they mutate items: a delta builds the streaming row, a
    // synthetic user message settles a tool call, execution events rewrite one.
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
    // The reset itself is content: a superseded reset is skipped with the
    // conversation it cleared, and the strictly-below skip keeps the latest.
    expect(transcriptContent({ type: 'conversation_reset' })).toBe(true)
  })

  it('classifies state a fresh attacher depends on as not-content', () => {
    expect(transcriptContent({ type: 'status_changed', status: 'idle' })).toBe(false)
    expect(transcriptContent({ type: 'capabilities', models: [], commands: [] })).toBe(false)
    expect(transcriptContent({ type: 'skills', skills: [] })).toBe(false)
    expect(transcriptContent({ type: 'model_changed', model: 'opus' })).toBe(false)
    expect(transcriptContent({ type: 'permission_mode_changed', mode: 'default' })).toBe(false)
    expect(transcriptContent({ type: 'plan_info', subscriptionType: 'max' })).toBe(false)
    expect(
      transcriptContent({ type: 'file_produced', fileId: 'f1', path: '/tmp/x.png' }),
    ).toBe(false)
    expect(
      transcriptContent({ type: 'rate_limit', info: { status: 'allowed' } }),
    ).toBe(false)
    // Permission bookkeeping survives a reset: a still-pending request is the
    // runner's, and skipping the `requested` half would hide it forever.
    expect(
      transcriptContent({
        type: 'permission_requested',
        request: { id: 'p1', toolName: 'Bash', input: {}, toolUseId: 't1' },
      }),
    ).toBe(false)
    // Unknown/future types default to not-content: the safe failure is
    // replaying a stale row, never withholding state.
    expect(transcriptContent({ type: 'sdk_event', payload: { type: 'x' } })).toBe(false)
  })
})
