import { describe, expect, it } from 'vitest'
import { snapshotRetains, transcriptActivity } from '@workerdeck/protocol'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/lib/transcript.ts'

const seqd = (bodies: SessionEventBody[]): SessionEvent[] => bodies.map((body, index) => ({ ...body, seq: index + 1, ts: 1000 + index }))

const retain = (events: SessionEvent[]): SessionEvent[] => events.filter((e) => snapshotRetains(e))

const fold = (events: SessionEvent[]): TranscriptState => events.reduce(applyEvent, initialTranscriptState)

const textDelta = (text: string, uuid: string): SessionEventBody => ({
  type: 'stream_delta',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  parentToolUseId: null,
  uuid,
})

const thinkingDelta = (thinking: string, uuid: string): SessionEventBody => ({
  type: 'stream_delta',
  event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } },
  parentToolUseId: null,
  uuid,
})

// How the provider runner flushes: the full text is in the block, never empty.
const assistantText = (text: string, uuid: string): SessionEventBody => ({
  type: 'assistant_message',
  message: { role: 'assistant', content: [{ type: 'text', text }], model: 'm' },
  parentToolUseId: null,
  uuid,
})

const turnEnd = (isError = false): SessionEventBody => ({
  type: 'turn_result',
  subtype: isError ? 'error_during_execution' : 'success',
  isError,
  durationMs: 10,
  numTurns: 1,
  totalCostUsd: 0,
  ...(isError ? { errors: ['interrupted'] } : {}),
})

const user = (content: string): SessionEventBody => ({
  type: 'user_message',
  message: { role: 'user', content },
  parentToolUseId: null,
})

describe('snapshot retention is unobservable', () => {
  it('lands on the same state as the full log, over a session of many turns', () => {
    const bodies: SessionEventBody[] = []
    for (let turn = 1; turn <= 20; turn++) {
      bodies.push({ type: 'status_changed', status: 'running' })
      bodies.push(user(`turn ${turn}`))
      const words = ['the ', 'answer ', `to ${turn}`]
      words.forEach((word, index) => bodies.push(textDelta(word, `d${turn}-${index}`)))
      bodies.push(assistantText(words.join(''), `a${turn}`))
      bodies.push(turnEnd())
      bodies.push({ type: 'status_changed', status: 'idle' })
    }
    const full = seqd(bodies)
    const thin = retain(full)

    expect(fold(thin)).toEqual(fold(full))
    expect(full.length - thin.length).toBe(20 * 3)
  })

  it('keeps the unread cursor bit-identical — a delta is worth zero rows', () => {
    const full = seqd([user('hi'), textDelta('par', 'd1'), textDelta('tial', 'd2'), assistantText('partial', 'a1'), turnEnd()])
    const count = (events: SessionEvent[]) => events.reduce((total, event) => total + transcriptActivity(event), 0)
    expect(count(retain(full))).toBe(count(full))
    expect(full.filter((e) => e.type === 'stream_delta').every((e) => transcriptActivity(e) === 0)).toBe(true)
  })

  it('survives an interrupted turn — the catch path flushes what it produced', () => {
    const full = seqd([
      user('write me an essay'),
      textDelta('half an ', 'd1'),
      textDelta('essay', 'd2'),
      assistantText('half an essay', 'a1'),
      turnEnd(true),
      { type: 'status_changed', status: 'idle' },
    ])
    const thin = retain(full)
    expect(fold(thin)).toEqual(fold(full))
    const text = fold(thin).items.find((item) => item.kind === 'assistant_text')
    expect(text).toMatchObject({ text: 'half an essay', streaming: false })
  })

  it('carries a provider thinking block through without its deltas', () => {
    const full = seqd([
      user('think about it'),
      thinkingDelta('let me ', 't1'),
      thinkingDelta('consider', 't2'),
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me consider' },
            { type: 'text', text: 'yes' },
          ],
          model: 'm',
        },
        parentToolUseId: null,
        uuid: 'a1',
      },
      turnEnd(),
    ])
    expect(fold(retain(full))).toEqual(fold(full))
    expect(fold(retain(full)).items.find((i) => i.kind === 'thinking')).toMatchObject({
      text: 'let me consider',
    })
  })

  it('leaves tool calls and their results strictly alone', () => {
    const full = seqd([
      user('run it'),
      textDelta('calling', 'd1'),
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tc1', name: 'Bash', input: { command: 'ls' } }],
          model: 'm',
        },
        parentToolUseId: null,
        uuid: 'a1',
      },
      {
        type: 'user_message',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'a.ts', is_error: false }],
        },
        parentToolUseId: null,
        synthetic: true,
        uuid: 'u1',
      },
      turnEnd(),
    ])
    const thin = retain(full)
    expect(full.length - thin.length).toBe(1)
    expect(fold(thin)).toEqual(fold(full))
    expect(fold(thin).items.find((i) => i.kind === 'tool_call')).toMatchObject({
      status: 'settled',
      result: { text: 'a.ts', isError: false },
    })
  })

  it('never drops the last event — the replay hold depends on it', () => {
    const full = seqd([user('hi'), textDelta('a', 'd1'), assistantText('a', 'a1'), turnEnd()])
    const thin = retain(full)
    expect(thin.at(-1)?.seq).toBe(full.at(-1)?.seq)
    expect(fold(thin).lastSeq).toBe(fold(full).lastSeq)
  })

  it('retains everything that is not a stream delta', () => {
    for (const body of [
      user('hi'),
      assistantText('yo', 'a1'),
      turnEnd(),
      { type: 'status_changed', status: 'idle' } as SessionEventBody,
      { type: 'session_error', message: 'boom' } as SessionEventBody,
      { type: 'file_delivered', path: 'out.md', bytes: 4 } as SessionEventBody,
    ]) {
      expect(snapshotRetains(body)).toBe(true)
    }
    expect(snapshotRetains(textDelta('x', 'd'))).toBe(false)
  })
})
