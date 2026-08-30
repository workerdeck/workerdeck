import { describe, expect, it } from 'vitest'
import { replayRetains } from '@workerdeck/protocol'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/lib/transcript.ts'

/**
 * `replayRetains` lives in `protocol` but is a **claim about this reducer**:
 * the gateway drops these events from an attach replay outright, and the client
 * must land in exactly the state the full log would have produced. Only this
 * package can prove that — `core`, which does the dropping, cannot import the
 * reducer — so the proof lives here, beside `replay-coalesce.test.ts` and
 * `snapshot-retain.test.ts`, which assert the same property about the other two
 * rules in the family.
 *
 * The property, stated once: **dropping is unobservable.** Fold the full log
 * and the retained log through `applyEvent`; the states must be identical.
 */

const seqd = (bodies: SessionEventBody[]): SessionEvent[] => bodies.map((body, index) => ({ ...body, seq: index + 1, ts: 1000 + index }))

const fold = (events: SessionEvent[]): TranscriptState => events.reduce(applyEvent, initialTranscriptState)

/** The gateway's rule as the runners apply it, including the guard that the
 * log's last event is delivered whatever the rule says. */
function retain(events: SessionEvent[]): SessionEvent[] {
  const lastSeq = events.at(-1)?.seq ?? 0
  return events.filter((event) => event.seq === lastSeq || replayRetains(event))
}

const delta = (event: Record<string, unknown>, uuid = 'u'): SessionEventBody => ({
  type: 'stream_delta',
  event: event as { type: string; [key: string]: unknown },
  parentToolUseId: null,
  uuid,
})

const text = (t: string) => delta({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })
const thought = (t: string) => delta({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: t } })
/** A tool call's arguments, streamed character by character. The single
 * biggest item in a real log's delta run — 383 KB of one measured session — and
 * the reducer does not model it at all. */
const args = (t: string) => delta({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: t } })

describe('replay dropping is unobservable', () => {
  it('lands on the same state as the full log, over a turn with every delta kind', () => {
    const bodies: SessionEventBody[] = [
      { type: 'user_message', message: { role: 'user', content: 'go' }, parentToolUseId: null },
      delta({ type: 'message_start', message: { role: 'assistant' } }),
      delta({ type: 'content_block_start', index: 0 }),
      thought('I should '),
      thought('read the file.'),
      delta({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x'.repeat(200) } }),
      delta({ type: 'content_block_stop', index: 0 }),
      delta({ type: 'content_block_start', index: 1 }),
      text('Reading '),
      text('now.'),
      delta({ type: 'content_block_stop', index: 1 }),
      delta({ type: 'content_block_start', index: 2 }),
      args('{"file'),
      args('_path":"'),
      args('/a/b.ts"}'),
      delta({ type: 'content_block_stop', index: 2 }),
      delta({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      delta({ type: 'message_stop' }),
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: 'Reading now.' },
            { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/a/b.ts' } },
          ],
        },
        parentToolUseId: null,
        uuid: 'msg-1',
      },
      { type: 'status_changed', status: 'idle' },
    ]
    const full = seqd(bodies)
    const thin = retain(full)

    expect(fold(thin)).toEqual(fold(full))
    // And it is worth doing: thirteen of the seventeen deltas were scaffolding
    // the reducer reads and throws away.
    expect(full.length - thin.length).toBe(13)
  })

  it('keeps the thinking the transcript would otherwise lose', () => {
    // The carve-out `snapshotRetains` documents, pinned as a test rather than a
    // comment: the Claude SDK sends thinking blocks whose `thinking` is '' and
    // the reducer backfills them from the accumulated stream. A rule that
    // dropped `thinking_delta` would erase every thought from a replayed
    // transcript and no other assertion here would notice.
    const full = seqd([
      thought('the summary '),
      thought('of a thought'),
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }] },
        parentToolUseId: null,
        uuid: 'msg-1',
      },
      { type: 'status_changed', status: 'idle' },
    ])
    const state = fold(retain(full))
    expect(state.items.find((item) => item.kind === 'thinking')).toMatchObject({
      text: 'the summary of a thought',
    })
    expect(state).toEqual(fold(full))
  })

  it('never drops the highest-seq event — the replay hold depends on it', () => {
    // A turn interrupted mid-stream ends on a delta the rule would otherwise
    // drop. The client's hold waits for `state.lastSeq` to reach the attach's
    // `session.lastSeq`, and would sit on a blank panel forever.
    const full = seqd([
      { type: 'user_message', message: { role: 'user', content: 'go' }, parentToolUseId: null },
      args('{"a'),
      args('":1}'),
    ])
    const thin = retain(full)
    expect(thin.at(-1)?.seq).toBe(full.at(-1)?.seq)
    expect(fold(thin).lastSeq).toBe(fold(full).lastSeq)
  })

  it('touches nothing that is not a stream delta', () => {
    // The rule is deliberately narrow. `sdk_event` in particular is *not* here:
    // the reducer ignores it today, but it is the escape hatch for SDK messages
    // this protocol version does not model, and withholding state is the failure
    // this family refuses. Its transient status payload is folded by
    // `replayCoalesceKey` instead, which keeps the newest rather than none.
    for (const body of [
      { type: 'sdk_event', payload: { type: 'system', subtype: 'status', status: 'requesting' } },
      { type: 'sdk_event', payload: { type: 'compact_boundary' } },
      { type: 'user_message', message: { role: 'user', content: 'hi' }, parentToolUseId: null },
      { type: 'context_usage', usage: { totalTokens: 1, maxTokens: 2, percentage: 1, categories: [] } },
    ] as SessionEventBody[]) {
      expect(replayRetains(body)).toBe(true)
    }
  })
})
