import { describe, expect, it } from 'vitest'
import type { ActiveTrigger, ChipSegment, Segment, TriggerConfig } from '../src/components/prompt-area/types.ts'
import {
  detectActiveTrigger,
  isValidTriggerPosition,
  mergeAdjacentTextSegments,
  parseInlineMarkdown,
  removeChipAtIndex,
  replaceTextRange,
  resolveChip,
  resolveText,
  resolveTriggersInSegments,
  revertChipAtIndex,
  segmentsEqual,
  segmentsToPlainText,
  toggleMarkdownWrap,
  truncateSegmentsToLength,
} from '../src/components/prompt-area/prompt-area-engine.ts'

const slash: TriggerConfig = { char: '/', position: 'start', mode: 'dropdown' }
const at: TriggerConfig = { char: '@', position: 'any', mode: 'dropdown' }
const hash: TriggerConfig = { char: '#', position: 'any', mode: 'dropdown', resolveOnSpace: true }

function t(text: string): Segment {
  return { type: 'text', text }
}
function c(value: string, trigger = '@', extra: Partial<ChipSegment> = {}): ChipSegment {
  return { type: 'chip', trigger, value, displayText: value, ...extra }
}
function active(config: TriggerConfig, query: string, startOffset: number): ActiveTrigger {
  return { config, query, startOffset }
}

describe('detectActiveTrigger', () => {
  it('finds a trigger at a word boundary and reports its query', () => {
    expect(detectActiveTrigger('hi @al', 6, [at])).toEqual({ config: at, startOffset: 3, query: 'al' })
    expect(detectActiveTrigger('@', 1, [at])).toEqual({ config: at, startOffset: 0, query: '' })
  })

  it('ignores an email-shaped @ and stops at whitespace', () => {
    expect(detectActiveTrigger('me@host', 7, [at])).toBeNull()
    expect(detectActiveTrigger('@al done', 8, [at])).toBeNull()
  })

  it('honours start-only triggers', () => {
    expect(detectActiveTrigger('/co', 3, [slash])).not.toBeNull()
    expect(detectActiveTrigger('x /co', 5, [slash])).toBeNull()
    expect(detectActiveTrigger('x\n/co', 5, [slash])).toEqual({ config: slash, startOffset: 2, query: 'co' })
  })

  it('treats a tab as a boundary', () => {
    expect(isValidTriggerPosition('a\t@', 2, 'any')).toBe(true)
  })
})

describe('resolveChip', () => {
  it('places the caret after the new chip even when an identical chip follows it', () => {
    const segments = [t('@al and '), c('alice'), t(' again')]
    const result = resolveChip(segments, active(at, 'al', 0), { value: 'alice', displayText: 'alice' })
    expect(segmentsToPlainText(result.segments)).toBe('@alice and @alice again')
    expect(result.cursorOffset).toBe('@alice '.length)
  })

  it('inserts exactly one chip when the trigger text spans unmerged text segments', () => {
    const result = resolveChip([t('@a'), t('l tail')], active(at, 'al', 0), { value: 'alice', displayText: 'alice' })
    expect(result.segments.filter((segment) => segment.type === 'chip')).toHaveLength(1)
    expect(segmentsToPlainText(result.segments)).toBe('@alice tail')
    expect(result.cursorOffset).toBe('@alice '.length)
  })

  it('keeps chips outside the trigger range', () => {
    const result = resolveChip([c('bob'), t(' @al')], active(at, 'al', 5), { value: 'alice', displayText: 'alice' })
    expect(result.segments).toEqual([c('bob'), t(' '), c('alice'), t(' ')])
    expect(result.cursorOffset).toBe('@bob @alice '.length)
  })
})

describe('resolveText', () => {
  it('replaces the trigger with editable text and clamps the caret', () => {
    const result = resolveText([t('/ski')], active(slash, 'ski', 0), 'use the skill ')
    expect(result.segments).toEqual([t('use the skill ')])
    expect(result.cursorOffset).toBe('use the skill '.length)
  })

  it('handles a trigger spread over unmerged text segments', () => {
    const result = resolveText([t('/s'), t('k rest')], active(slash, 'sk', 0), 'X')
    expect(segmentsToPlainText(result.segments)).toBe('X rest')
  })
})

describe('replaceTextRange', () => {
  it('inserts at a text/chip boundary without losing either side', () => {
    expect(replaceTextRange([t('ab'), c('x'), t('cd')], 2, 2, 'Z')).toEqual([t('abZ'), c('x'), t('cd')])
    expect(replaceTextRange([c('x'), t('cd')], 0, 0, 'Z')).toEqual([t('Z'), c('x'), t('cd')])
    expect(replaceTextRange([t('ab')], 2, 2, 'Z')).toEqual([t('abZ')])
  })

  it('puts the replacement where a range starting at a chip began', () => {
    const result = replaceTextRange([t('ab'), c('x'), t('cd')], 2, 5, 'Z')
    expect(segmentsToPlainText(result)).toBe('abZd')
  })

  it('never deletes a chip for a collapsed insertion inside it', () => {
    const result = replaceTextRange([c('xyz'), t('!')], 2, 2, 'Z')
    expect(result.some((segment) => segment.type === 'chip')).toBe(true)
    expect(segmentsToPlainText(result)).toBe('@xyzZ!')
  })

  it('replaces across text on both sides of a chip', () => {
    expect(segmentsToPlainText(replaceTextRange([t('ab'), c('x'), t('cd')], 1, 5, 'Z'))).toBe('aZd')
  })
})

describe('toggleMarkdownWrap', () => {
  it('wraps and unwraps a selection, keeping it selected', () => {
    const wrapped = toggleMarkdownWrap([t('say hi now')], 4, 6, '**')
    expect(wrapped).toEqual({ segments: [t('say **hi** now')], selectionStart: 6, selectionEnd: 8 })
    const unwrapped = toggleMarkdownWrap(wrapped!.segments, 6, 8, '**')
    expect(unwrapped).toEqual({ segments: [t('say hi now')], selectionStart: 4, selectionEnd: 6 })
  })

  it('does not mistake bold for italic', () => {
    const result = toggleMarkdownWrap([t('**hi**')], 2, 4, '*')
    expect(segmentsToPlainText(result!.segments)).toBe('***hi***')
  })

  it('does nothing for a collapsed selection', () => {
    expect(toggleMarkdownWrap([t('x')], 1, 1, '*')).toBeNull()
  })
})

describe('chip removal and revert', () => {
  it('merges the text around a removed chip', () => {
    expect(removeChipAtIndex([t('a '), c('x'), t(' b')], 1)).toEqual([t('a  b')])
    const segments = [t('a')]
    expect(removeChipAtIndex(segments, 0)).toBe(segments)
    expect(removeChipAtIndex(segments, 5)).toBe(segments)
  })

  it('reverts only auto-resolved chips', () => {
    expect(revertChipAtIndex([c('x')], 0)).toBeNull()
    expect(revertChipAtIndex([t('see '), c('readme', '#', { autoResolved: true })], 1)).toEqual({
      segments: [t('see #readme')],
      revertedText: '#readme',
    })
  })
})

describe('resolveTriggersInSegments', () => {
  it('turns boundary patterns into auto-resolved chips and leaves the rest', () => {
    const result = resolveTriggersInSegments([t('see #readme and a#b #')], [hash, at])
    expect(result).toEqual([t('see '), c('readme', '#', { autoResolved: true }), t(' and a#b #')])
  })

  it('uses onSelect for the label and falls back to the query when it is empty', () => {
    const labelled: TriggerConfig = { ...hash, onSelect: ({ value }) => (value === 'x' ? '' : value.toUpperCase()) }
    const result = resolveTriggersInSegments([t('#ab #x')], [labelled])
    expect(result.filter((segment) => segment.type === 'chip').map((chip) => (chip as ChipSegment).displayText)).toEqual(['AB', 'x'])
  })
})

describe('segment utilities', () => {
  it('truncates without splitting a surrogate pair or a chip', () => {
    expect(truncateSegmentsToLength([t('a😀b')], 2)).toEqual([t('a')])
    expect(truncateSegmentsToLength([t('ab'), c('long')], 4)).toEqual([t('ab')])
    expect(truncateSegmentsToLength([t('ab')], 0)).toEqual([])
  })

  it('compares chips by what they serialize to, sigil included', () => {
    expect(segmentsEqual([c('pdf', '/', { sigil: '$' })], [c('pdf', '/')])).toBe(false)
    expect(segmentsEqual([c('pdf', '/', { sigil: '$' })], [c('pdf', '/', { sigil: '$' })])).toBe(true)
  })

  it('merges text and drops empties', () => {
    expect(mergeAdjacentTextSegments([t(''), t('a'), t('b'), c('x'), t('')])).toEqual([t('ab'), c('x')])
  })

  it('parses inline markdown emphasis and urls', () => {
    expect(parseInlineMarkdown('a ***b*** **c** *d* https://x.io/y, e')).toEqual([
      { type: 'plain', text: 'a ' },
      { type: 'bold-italic', text: 'b' },
      { type: 'plain', text: ' ' },
      { type: 'bold', text: 'c' },
      { type: 'plain', text: ' ' },
      { type: 'italic', text: 'd' },
      { type: 'plain', text: ' ' },
      { type: 'url', text: 'https://x.io/y' },
      { type: 'plain', text: ', e' },
    ])
  })
})
