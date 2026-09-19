import { describe, expect, it } from 'vitest'
import type { ActiveTrigger, Segment } from '../src/components/prompt-area/types.ts'
import {
  chipPlainText,
  resolveChip,
  segmentsToPlainText,
  truncateSegmentsToLength,
} from '../src/components/prompt-area/prompt-area-engine.ts'

function active(query: string, startOffset = 0): ActiveTrigger {
  return { config: { char: '/', position: 'any', mode: 'dropdown', chipStyle: 'inline' }, query, startOffset }
}

describe('chip sigil', () => {
  it('serialises with the sigil in place of the trigger', () => {
    const chip: Segment = { type: 'chip', trigger: '/', value: 'pdf', displayText: 'pdf', sigil: '$' }
    expect(chipPlainText(chip)).toBe('$pdf')
    expect(segmentsToPlainText([{ type: 'text', text: 'use ' }, chip])).toBe('use $pdf')
    expect(truncateSegmentsToLength([chip, { type: 'text', text: ' now' }], 5)).toEqual([chip, { type: 'text', text: ' ' }])
  })

  it('falls back to the trigger when no sigil is set', () => {
    expect(chipPlainText({ type: 'chip', trigger: '@', value: 'a', displayText: 'a.ts' })).toBe('@a.ts')
  })
})

describe('resolveChip with chip options', () => {
  it('replaces the /query with a sigil chip and puts the trailing text after it', () => {
    const result = resolveChip(
      [{ type: 'text', text: '/pd' }],
      active('pd'),
      { value: 'pdf', displayText: 'pdf', sigil: '$' },
      ' inspect this ',
    )
    expect(result.segments).toEqual([
      { type: 'chip', trigger: '/', value: 'pdf', displayText: 'pdf', sigil: '$' },
      { type: 'text', text: ' inspect this ' },
    ])
    expect(segmentsToPlainText(result.segments)).toBe('$pdf inspect this ')
    expect(result.cursorOffset).toBe('$pdf inspect this '.length)
  })

  it('keeps text after the trigger, folding its leading space into the trailing text', () => {
    const result = resolveChip(
      [{ type: 'text', text: 'a /pd tail' }],
      active('pd', 2),
      { value: 'pdf', displayText: 'pdf', sigil: '$' },
      ' go ',
    )
    expect(segmentsToPlainText(result.segments)).toBe('a $pdf go tail')
    expect(result.cursorOffset).toBe('a $pdf go '.length)
  })

  it('still inserts a plain chip and one space by default', () => {
    const result = resolveChip([{ type: 'text', text: '/comp' }], active('comp'), { value: 'compact', displayText: 'compact' })
    expect(result.segments).toEqual([
      { type: 'chip', trigger: '/', value: 'compact', displayText: 'compact' },
      { type: 'text', text: ' ' },
    ])
    expect(segmentsToPlainText(result.segments)).toBe('/compact ')
    expect(result.cursorOffset).toBe('/compact '.length)
  })
})
