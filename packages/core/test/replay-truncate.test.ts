/**
 * Truncation on the replay path, stated **honestly**: unlike every other rule in
 * this family, it is *not* fold-equal. It loses characters on purpose. What it
 * must not lose is anything else — the event's identity, the other blocks in the
 * same message, the stored log, or the ability to get the rest back.
 */
import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_HEAD_CHARS, type SessionEvent } from '@workerdeck/protocol'
import { replaySlice, truncateResultBlocks } from '../src/lib/replay.ts'

const big = 'x'.repeat(TOOL_RESULT_HEAD_CHARS + 1_000)

const resultEvent = (seq: number, blocks: unknown[]): SessionEvent =>
  ({
    seq,
    ts: seq,
    type: 'user_message',
    message: { role: 'user', content: blocks },
  }) as unknown as SessionEvent

const toolResult = (id: string, content: unknown) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
})

describe('truncateResultBlocks', () => {
  it('keeps the head, and says how much there was', () => {
    const event = truncateResultBlocks(resultEvent(1, [toolResult('a', big)])) as never
    const block = (event as { message: { content: Array<Record<string, unknown>> } }).message.content[0]!
    expect(block.content).toBe(big.slice(0, TOOL_RESULT_HEAD_CHARS))
    expect(block.truncated).toBe(true)
    expect(block.total_chars).toBe(big.length)
  })

  it('cuts blocks individually — a big result beside two small ones', () => {
    const event = truncateResultBlocks(resultEvent(1, [toolResult('a', 'short'), toolResult('b', big), toolResult('c', 'also short')]))
    const blocks = (event as { message: { content: Array<Record<string, unknown>> } }).message.content
    expect(blocks[0]).toEqual(toolResult('a', 'short'))
    expect(blocks[1]!.truncated).toBe(true)
    expect(blocks[2]).toEqual(toolResult('c', 'also short'))
  })

  it('preserves the content SHAPE — a block list stays a block list', () => {
    const event = truncateResultBlocks(resultEvent(1, [toolResult('a', [{ type: 'text', text: big }])]))
    const block = (event as { message: { content: Array<Record<string, unknown>> } }).message.content[0]!
    expect(Array.isArray(block.content)).toBe(true)
    expect((block.content as Array<{ text: string }>)[0]!.text.length).toBe(TOOL_RESULT_HEAD_CHARS)
    expect(block.total_chars).toBe(big.length)
  })

  it('returns the SAME OBJECT when nothing is over budget', () => {
    // Identity, not equality: an attach is mostly small events, and a fresh
    // object for each would cost more than the feature saves.
    const event = resultEvent(1, [toolResult('a', 'small')])
    expect(truncateResultBlocks(event)).toBe(event)
  })

  it('leaves everything that is not a user message alone', () => {
    const event = { seq: 1, ts: 1, type: 'status_changed', status: 'idle' } as unknown as SessionEvent
    expect(truncateResultBlocks(event)).toBe(event)
  })
})

describe('replaySlice', () => {
  const log = (): SessionEvent[] => [
    resultEvent(1, [toolResult('a', big)]),
    { seq: 2, ts: 2, type: 'status_changed', status: 'idle' } as unknown as SessionEvent,
    resultEvent(3, [toolResult('b', big)]),
  ]

  it('does not mutate the stored log — parking and the fetch route read it', () => {
    const events = log()
    replaySlice(events, { afterSeq: 0, truncateResults: true })
    const first = events[0] as unknown as { message: { content: Array<{ content: string }> } }
    expect(first.message.content[0]!.content).toBe(big)
  })

  it('is byte-identical to the log when nobody asked for truncation', () => {
    const events = log()
    expect(replaySlice(events, { afterSeq: 0 })).toEqual(events)
  })

  it('truncates the HIGHEST-SEQ event too — a session ending on a `find /`', () => {
    // It is delivered whatever the coalesce rule says (the replay hold waits for
    // it), but "delivered" was never "delivered whole".
    const out = replaySlice(log(), { afterSeq: 0, truncateResults: true, coalesceReplay: true })
    const last = out[out.length - 1] as unknown as {
      seq: number
      message: { content: Array<{ truncated?: boolean }> }
    }
    expect(last.seq).toBe(3)
    expect(last.message.content[0]!.truncated).toBe(true)
  })

  it('honours afterSeq and the reset watermark exactly as the three copies did', () => {
    expect(replaySlice(log(), { afterSeq: 2 }).map((e) => e.seq)).toEqual([3])
    // Content below the reset is skipped; state-bearing events are not.
    expect(replaySlice(log(), { afterSeq: 0, resetSeq: 3 }).map((e) => e.seq)).toEqual([2, 3])
  })
})
