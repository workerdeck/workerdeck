/**
 * The reducer's half of the image-ref rule, and the second property in this
 * family stated as an **inequality**.
 *
 * The claim: folding a ref'd log differs from folding the full log in
 * `result.images` and **nowhere else**. Not the text (base64 parts never
 * contributed any), not the statuses, not one field of any other item. A log
 * with no pictures in it must fold *exactly* equal — that is what makes this
 * additive at protocol 7 rather than a wire change every client must learn.
 *
 * The reason the text half is worth asserting rather than assuming: the whole
 * measured justification is that these bytes were already being discarded. If
 * the fold moves at all, they were not.
 */
import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_HEAD_CHARS, type SessionEvent } from '@workerdeck/protocol'
import { replaySlice } from '@workerdeck/core'
import { applyEvent, hydrateToolResult, initialTranscriptState } from '../src/lib/transcript.ts'

const png = (n: number) => {
  // Exact decoded size, padding included, so an asserted `bytes` is the real one.
  const pad = n % 3 === 0 ? 0 : n % 3 === 1 ? 2 : 1
  return 'A'.repeat(Math.ceil(n / 3) * 4 - pad) + '='.repeat(pad)
}
const big = 'x'.repeat(TOOL_RESULT_HEAD_CHARS + 5_000)

const image = (data: string, mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data },
})

const log = (resultContent: unknown): SessionEvent[] =>
  [
    {
      seq: 1,
      ts: 1,
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'shot.png' } }],
      },
    },
    {
      seq: 2,
      ts: 2,
      type: 'user_message',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: resultContent }],
      },
    },
    { seq: 3, ts: 3, type: 'turn_result', ok: true },
  ] as unknown as SessionEvent[]

const fold = (events: readonly SessionEvent[]) => events.reduce(applyEvent, initialTranscriptState)

const foldOf = (events: SessionEvent[], options: Record<string, boolean>) => fold(replaySlice(events, { afterSeq: 0, ...options }))

describe('image refs — the fold moves in exactly one field', () => {
  const events = log([
    { type: 'text', text: 'looked at the screenshot' },
    image(png(340_000)),
    { type: 'tool_reference', tool_name: 'Read' },
  ])

  it('differs from the full fold only in result.images', () => {
    const whole = foldOf(events, {})
    const refd = foldOf(events, { imageRefs: true })

    const call = refd.items.find((item) => item.kind === 'tool_call')!
    expect(call.result?.images).toEqual([{ partIndex: 1, mediaType: 'image/png', bytes: 340_000, sourceSeq: 2 }])

    // Strip the one field that is allowed to move; everything else must match.
    const strip = (state: typeof refd) => ({
      ...state,
      items: state.items.map((item) =>
        item.kind === 'tool_call' && item.result ? { ...item, result: { ...item.result, images: undefined } } : item,
      ),
    })
    expect(strip(refd)).toEqual(strip(whole))
  })

  it('does not move the text — which is the whole measured justification', () => {
    const textOf = (state: ReturnType<typeof fold>) => state.items.find((item) => item.kind === 'tool_call')!.result?.text
    expect(textOf(foldOf(events, { imageRefs: true }))).toBe('looked at the screenshot')
    expect(textOf(foldOf(events, { imageRefs: true }))).toBe(textOf(foldOf(events, {})))
  })

  it('folds EXACTLY equal for a log with no pictures in it', () => {
    const plain = log([{ type: 'text', text: 'no images here' }])
    expect(foldOf(plain, { imageRefs: true })).toEqual(foldOf(plain, {}))
  })

  it('leaves images absent rather than empty, so untouched items stay identical', () => {
    const plain = log('a plain string result')
    const call = foldOf(plain, { imageRefs: true }).items.find((i) => i.kind === 'tool_call')!
    expect(call.result).not.toHaveProperty('images')
  })
})

describe('image refs composed with truncation', () => {
  const events = log([{ type: 'text', text: big }, image(png(500_000), 'image/jpeg')])

  it('carries both rules’ markers and nothing more', () => {
    const call = foldOf(events, { imageRefs: true, truncateResults: true }).items.find((i) => i.kind === 'tool_call')!
    expect(call.result?.truncated).toBe(true)
    expect(call.result?.text.length).toBe(TOOL_RESULT_HEAD_CHARS)
    // The picture is still addressable even though the text was cut past it.
    expect(call.result?.images).toEqual([{ partIndex: 1, mediaType: 'image/jpeg', bytes: 500_000, sourceSeq: 2 }])
  })

  it('keeps images through text hydration — the press must not orphan the picture', () => {
    const state = foldOf(events, { imageRefs: true, truncateResults: true })
    const hydrated = hydrateToolResult(state, 'call-1', big)
    const call = hydrated.items.find((i) => i.kind === 'tool_call')!
    // Truncation markers are gone (a hydrated result is indistinguishable from
    // one never cut) but the addresses survive, because they answer a different
    // press and nothing else will re-deliver them.
    expect(call.result?.truncated).toBeUndefined()
    expect(call.result?.text).toBe(big)
    expect(call.result?.images).toEqual([{ partIndex: 1, mediaType: 'image/jpeg', bytes: 500_000, sourceSeq: 2 }])
  })
})
