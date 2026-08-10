import { describe, expect, it } from 'vitest'
import { transcriptActivity, type SessionEventBody } from '@workerdeck/protocol'

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
  })
})
