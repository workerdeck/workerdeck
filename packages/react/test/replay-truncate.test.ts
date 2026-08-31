import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_HEAD_CHARS, type SessionEvent } from '@workerdeck/protocol'
import { replaySlice } from '@workerdeck/core'
import { applyEvent, hydrateToolResult, initialTranscriptState } from '../src/lib/transcript.ts'

const big = 'x'.repeat(TOOL_RESULT_HEAD_CHARS + 5_000)

const log = (): SessionEvent[] =>
  [
    {
      seq: 1,
      ts: 1,
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'find /' } },
          { type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    },
    {
      seq: 2,
      ts: 2,
      type: 'user_message',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: big },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'export const a = 1' },
        ],
      },
    },
  ] as unknown as SessionEvent[]

const fold = (events: SessionEvent[]) => events.reduce(applyEvent, initialTranscriptState)

describe('a truncated replay', () => {
  const whole = fold(log())
  const cut = fold(replaySlice(log(), { afterSeq: 0, truncateResults: true }))

  it('differs from the full fold ONLY in the truncated result', () => {
    expect({ ...cut, items: undefined }).toEqual({ ...whole, items: undefined })
    expect(cut.items.length).toBe(whole.items.length)
    expect(cut.items[1]).toEqual(whole.items[1])
  })

  it('carries a prefix plus the three markers, and nothing else changes', () => {
    const item = cut.items[0]
    if (item?.kind !== 'tool_call') {
      throw new Error('expected a tool call')
    }
    expect(item.result?.text).toBe(big.slice(0, TOOL_RESULT_HEAD_CHARS))
    expect(item.result?.truncated).toBe(true)
    expect(item.result?.totalChars).toBe(big.length)
    expect(item.result?.sourceSeq).toBe(2)
    expect(item.status).toBe('settled')
    expect({ ...item, result: undefined }).toEqual({ ...whole.items[0], result: undefined })
  })

  it('sets no marker on a result that was never cut', () => {
    const item = cut.items[1]
    if (item?.kind !== 'tool_call') {
      throw new Error('expected a tool call')
    }
    expect(item.result).toEqual({ text: 'export const a = 1', isError: false })
  })
})

describe('hydration', () => {
  const cut = fold(replaySlice(log(), { afterSeq: 0, truncateResults: true }))

  it('restores EXACT equality with the untruncated fold', () => {
    expect(hydrateToolResult(cut, 'call-1', big)).toEqual(fold(log()))
  })

  it('leaves an unknown id, and an untruncated row, alone — by identity', () => {
    expect(hydrateToolResult(cut, 'call-404', 'whatever')).toBe(cut)
    expect(hydrateToolResult(cut, 'call-2', 'whatever')).toBe(cut)
  })

  it('survives later events — the row is hydrated, not re-cut', () => {
    const hydrated = hydrateToolResult(cut, 'call-1', big)
    const after = applyEvent(hydrated, {
      seq: 3,
      ts: 3,
      type: 'status_changed',
      status: 'idle',
    } as unknown as SessionEvent)
    const item = after.items[0]
    if (item?.kind !== 'tool_call') {
      throw new Error('expected a tool call')
    }
    expect(item.result?.text).toBe(big)
    expect(item.result?.truncated).toBeUndefined()
  })
})
