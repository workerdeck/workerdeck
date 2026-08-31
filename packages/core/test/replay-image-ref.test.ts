import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_HEAD_CHARS, type SessionEvent } from '@workerdeck/protocol'
import { refImageParts, replaySlice } from '../src/lib/replay.ts'

const png = (n: number) => {
  // Base64 of exactly n decoded bytes, padding included, so an asserted `bytes` is the real one.
  const pad = n % 3 === 0 ? 0 : n % 3 === 1 ? 2 : 1
  return 'A'.repeat(Math.ceil(n / 3) * 4 - pad) + '='.repeat(pad)
}
const big = 'x'.repeat(TOOL_RESULT_HEAD_CHARS + 1_000)

const image = (data: string, mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data },
})

const resultEvent = (seq: number, blocks: unknown[]): SessionEvent =>
  ({ seq, ts: seq, type: 'user_message', message: { role: 'user', content: blocks } }) as unknown as SessionEvent

const toolResult = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content })

const partsOf = (event: SessionEvent, block = 0) =>
  (event as unknown as { message: { content: Array<{ content: Array<Record<string, unknown>> }> } }).message.content[block]!.content

describe('refImageParts', () => {
  it('replaces a base64 image with its address, and says how big it was', () => {
    const event = refImageParts(resultEvent(1, [toolResult('a', [image(png(9_000))])]))
    expect(partsOf(event)[0]).toEqual({
      type: 'image_ref',
      media_type: 'image/png',
      bytes: 9_000,
      part_index: 0,
    })
  })

  it('keeps order and count, and leaves text and tool_reference parts alone', () => {
    const event = refImageParts(
      resultEvent(1, [
        toolResult('a', [
          { type: 'text', text: 'before' },
          image(png(600)),
          { type: 'tool_reference', tool_name: 'Read' },
          { type: 'text', text: 'after' },
        ]),
      ]),
    )
    const parts = partsOf(event)
    expect(parts).toHaveLength(4)
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_ref', 'tool_reference', 'text'])
    expect(parts[2]).toEqual({ type: 'tool_reference', tool_name: 'Read' })
    expect(parts[3]).toEqual({ type: 'text', text: 'after' })
  })

  it('addresses each image by its index in the STORED array', () => {
    const event = refImageParts(
      resultEvent(1, [toolResult('a', [{ type: 'text', text: 'x' }, image(png(300)), { type: 'text', text: 'y' }, image(png(300))])]),
    )
    expect(
      partsOf(event)
        .filter((p) => p.type === 'image_ref')
        .map((p) => p.part_index),
    ).toEqual([1, 3])
  })

  it('refs blocks individually — an image beside a plain result', () => {
    const event = refImageParts(resultEvent(1, [toolResult('a', 'plain'), toolResult('b', [image(png(500))])]))
    const blocks = (event as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content
    expect(blocks[0]).toEqual(toolResult('a', 'plain'))
    expect((blocks[1]!.content as Array<{ type: string }>)[0]!.type).toBe('image_ref')
  })

  it('returns the SAME OBJECT when there is no image to ref', () => {
    const event = resultEvent(1, [toolResult('a', [{ type: 'text', text: 'hi' }])])
    expect(refImageParts(event)).toBe(event)
    const plain = { seq: 2, ts: 2, type: 'status_changed', status: 'idle' } as unknown as SessionEvent
    expect(refImageParts(plain)).toBe(plain)
  })

  it('never mutates the stored event — the log is what serves the bytes back', () => {
    const stored = resultEvent(1, [toolResult('a', [image(png(4_000))])])
    const before = JSON.stringify(stored)
    refImageParts(stored)
    expect(JSON.stringify(stored)).toBe(before)
  })

  it('ignores a non-base64 image source rather than minting an address for it', () => {
    const event = resultEvent(1, [toolResult('a', [{ type: 'image', source: { type: 'url', url: 'https://example/x.png' } }])])
    expect(refImageParts(event)).toBe(event)
  })
})

describe('replaySlice — the two rules composed', () => {
  const composed = (blocks: unknown[]) => replaySlice([resultEvent(1, blocks)], { afterSeq: 0, imageRefs: true, truncateResults: true })[0]!

  it('keeps the image address even when the text is truncated away past it', () => {
    const parts = partsOf(composed([toolResult('a', [{ type: 'text', text: big }, image(png(700))])]))
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_ref'])
    expect(parts[1]!.part_index).toBe(1)
    expect((parts[0]!.text as string).length).toBe(TOOL_RESULT_HEAD_CHARS)
  })

  it('addresses by the stored index, not the delivered position', () => {
    // Stored: [image, text(big), image] — truncation renumbers what is delivered.
    const parts = partsOf(composed([toolResult('a', [image(png(100)), { type: 'text', text: big }, image(png(200))])]))
    expect(parts.filter((p) => p.type === 'image_ref').map((p) => p.part_index)).toEqual([0, 2])
  })

  it('a truncate-only socket is byte-identical to before this rule existed', () => {
    const stored = [resultEvent(1, [toolResult('a', [{ type: 'text', text: big }, image(png(700))])])]
    const only = replaySlice(stored, { afterSeq: 0, truncateResults: true })[0]!
    expect(partsOf(only).map((p) => p.type)).toEqual(['text'])
  })

  it('still delivers the highest-seq event, and still refs it', () => {
    const events = [
      { seq: 1, ts: 1, type: 'status_changed', status: 'running' } as unknown as SessionEvent,
      resultEvent(2, [toolResult('a', [image(png(665_000))])]),
    ]
    const out = replaySlice(events, { afterSeq: 0, imageRefs: true, coalesceReplay: true })
    const last = out[out.length - 1]!
    expect(last.seq).toBe(2)
    expect(partsOf(last)[0]!.type).toBe('image_ref')
  })
})
