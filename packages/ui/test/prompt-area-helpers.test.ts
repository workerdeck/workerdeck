import { describe, expect, it } from 'vitest'
import { chip, getChips, getChipsByTrigger, hasChips, isSegmentsEmpty, text } from '../src/components/prompt-area/segment-helpers.ts'
import { parseSegmentsFromClipboard } from '../src/components/prompt-area/clipboard-helpers.ts'

describe('segment helpers', () => {
  it('builds and inspects segments', () => {
    const segments = [
      text('hi '),
      chip({ trigger: '@', value: 'u1', displayText: 'Alice' }),
      chip({ trigger: '#', value: 'r', displayText: 'readme' }),
    ]
    expect(hasChips(segments)).toBe(true)
    expect(getChips(segments)).toHaveLength(2)
    expect(getChipsByTrigger(segments, '#').map((segment) => segment.value)).toEqual(['r'])
  })

  it('counts whitespace-only text as empty but never a chip', () => {
    expect(isSegmentsEmpty([])).toBe(true)
    expect(isSegmentsEmpty([text(' \n ')])).toBe(true)
    expect(isSegmentsEmpty([chip({ trigger: '@', value: 'a', displayText: 'a' })])).toBe(false)
  })
})

describe('parseSegmentsFromClipboard', () => {
  it('round-trips text and chips, keeping sigil, data and autoResolved', () => {
    const segments = [
      { type: 'text', text: 'a' },
      { type: 'chip', trigger: '/', value: 'pdf', displayText: 'pdf', sigil: '$', data: { n: 1 }, autoResolved: true },
    ]
    expect(parseSegmentsFromClipboard(JSON.stringify(segments))).toEqual(segments)
  })

  it('rejects anything that is not a well-formed segment array', () => {
    expect(parseSegmentsFromClipboard('not json')).toBeNull()
    expect(parseSegmentsFromClipboard('{"type":"text"}')).toBeNull()
    expect(parseSegmentsFromClipboard('[{"type":"text","text":1}]')).toBeNull()
    expect(parseSegmentsFromClipboard('[{"type":"chip","trigger":"@","value":"a"}]')).toBeNull()
    expect(parseSegmentsFromClipboard('[null]')).toBeNull()
  })

  it('drops unknown fields and a non-string sigil', () => {
    expect(parseSegmentsFromClipboard('[{"type":"chip","trigger":"@","value":"a","displayText":"A","sigil":3,"evil":true}]')).toEqual([
      { type: 'chip', trigger: '@', value: 'a', displayText: 'A' },
    ])
  })
})
