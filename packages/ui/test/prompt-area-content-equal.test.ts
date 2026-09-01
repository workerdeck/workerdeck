import { describe, expect, it } from 'vitest'
import type { Segment } from '../src/components/prompt-area/types.ts'
import { segmentsContentEqual } from '../src/components/prompt-area/prompt-area-engine.ts'

function text(t: string): Segment {
  return { type: 'text', text: t }
}

function chip(display: string, value = display): Segment {
  return { type: 'chip', trigger: '@', value, displayText: display }
}

// The value-sync effect uses segmentsContentEqual to decide whether the
// contentEditable already shows the incoming value: equal means "adopt, don't
// rebuild" (a rebuild churns the caret), unequal means a genuine external
// change that must render. A DOM read arrives re-chunked — decorations split
// text nodes and each <br> reads back as its own "\n" segment — so equality
// must ignore segmentation while never ignoring content.
describe('segmentsContentEqual', () => {
  it('treats a decoration-split DOM read as equal to the merged model', () => {
    expect(segmentsContentEqual([text('see '), text('**bold**'), text(' end')], [text('see **bold** end')])).toBe(true)
  })

  it('treats per-<br> newline reads as equal to embedded newlines', () => {
    expect(segmentsContentEqual([text('a'), text('\n'), text('b')], [text('a\nb')])).toBe(true)
  })

  it('ignores empty text segments on either side', () => {
    expect(segmentsContentEqual([text(''), text('hi')], [text('hi'), text('')])).toBe(true)
    expect(segmentsContentEqual([text('')], [])).toBe(true)
  })

  it('is order-insensitive to chunking but not to content', () => {
    expect(segmentsContentEqual([text('this is ')], [text('this is a')])).toBe(false)
    expect(segmentsContentEqual([text('ab')], [text('ba')])).toBe(false)
  })

  it('does not merge text across a chip', () => {
    expect(segmentsContentEqual([text('a'), chip('x'), text('b')], [text('a'), chip('x'), text('b')])).toBe(true)
    expect(segmentsContentEqual([text('a'), chip('x'), text('b')], [text('ab'), chip('x')])).toBe(false)
  })

  it('compares chip identity fields, not just their display length', () => {
    expect(segmentsContentEqual([chip('same', 'value-1')], [chip('same', 'value-2')])).toBe(false)
    expect(segmentsContentEqual([chip('a')], [text('@a')])).toBe(false)
  })

  it('treats two empty values as equal', () => {
    expect(segmentsContentEqual([], [])).toBe(true)
  })
})
