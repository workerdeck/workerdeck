import { describe, expect, it } from 'vitest'
import type { ChipSegment, Segment } from '../src/components/prompt-area/types.ts'
import {
  autoFormatListPrefix,
  getListContext,
  hasOrderedListRun,
  indentListItem,
  insertListContinuation,
  normalizeListPrefixText,
  normalizeListPrefixes,
  outdentListItem,
  remapOffset,
  removeListPrefix,
  renumberOrderedListLines,
  renumberOrderedListSegments,
} from '../src/components/prompt-area/prompt-area-list-ops.ts'
import { segmentsToPlainText } from '../src/components/prompt-area/prompt-area-engine.ts'

function t(text: string): Segment {
  return { type: 'text', text }
}
function c(value: string): ChipSegment {
  return { type: 'chip', trigger: '@', value, displayText: value }
}
function plain(result: { segments: Segment[] } | null): string | undefined {
  return result ? segmentsToPlainText(result.segments) : undefined
}

describe('getListContext', () => {
  it('reads bullets, numbers and indentation', () => {
    expect(getListContext('x\n  • item', 6)).toEqual({
      lineStart: 2,
      prefix: '  • ',
      indent: 1,
      listType: 'bullet',
      marker: '•',
      contentStart: 6,
    })
    expect(getListContext('12. go', 6)).toMatchObject({ listType: 'numbered', number: 12, contentStart: 4 })
    expect(getListContext('plain', 2)).toBeNull()
  })
})

describe('list editing', () => {
  it('auto-formats a typed dash into a bullet', () => {
    const result = autoFormatListPrefix([t('a\n  - ')], 6)
    expect(plain(result)).toBe('a\n  • ')
    expect(result?.cursorOffset).toBe(6)
    expect(autoFormatListPrefix([t('a - ')], 4)).toBeNull()
  })

  it('continues a list on Enter, keeping marker and incrementing numbers', () => {
    expect(plain(insertListContinuation([t('- a')], 3))).toBe('- a\n- ')
    const numbered = insertListContinuation([t('3. a')], 4)
    expect(plain(numbered)).toBe('3. a\n4. ')
    expect(numbered?.cursorOffset).toBe(8)
  })

  it('exits or outdents on Enter in an empty item', () => {
    expect(plain(insertListContinuation([t('• a\n• ')], 6))).toBe('• a\n')
    const nested = insertListContinuation([t('• a\n  • ')], 8)
    expect(plain(nested)).toBe('• a\n• ')
    expect(nested?.cursorOffset).toBe(6)
  })

  it('indents only under a preceding item, and outdents back', () => {
    expect(indentListItem([t('• a')], 3)).toBeNull()
    const indented = indentListItem([t('• a\n• b')], 7)
    expect(plain(indented)).toBe('• a\n  • b')
    expect(indentListItem(indented!.segments, 9)).toBeNull()
    expect(plain(outdentListItem(indented!.segments, 9))).toBe('• a\n• b')
    expect(outdentListItem([t('• a')], 3)).toBeNull()
  })

  it('removes a prefix only with the caret at or before the content', () => {
    expect(plain(removeListPrefix([t('  • a')], 4))).toBe('  a')
    expect(removeListPrefix([t('• ab')], 3)).toBeNull()
  })

  it('keeps chips intact through list edits', () => {
    const result = insertListContinuation([t('- see '), c('bob')], 10)
    expect(result?.segments).toEqual([t('- see '), c('bob'), t('\n- ')])
  })
})

describe('normalizeListPrefixes', () => {
  it('swaps markers both ways outside balanced fences', () => {
    const text = '- a\n```\n- code\n```\n- b'
    expect(normalizeListPrefixText(text, true)).toBe('• a\n```\n- code\n```\n• b')
    expect(normalizeListPrefixText('• a', false)).toBe('- a')
    expect(normalizeListPrefixText('```\n- a', true)).toBe('```\n• a')
  })

  it('returns the same array when nothing changes', () => {
    const segments = [t('plain')]
    expect(normalizeListPrefixes(segments, true)).toBe(segments)
  })

  it('never treats text after an inline chip as the start of a line', () => {
    const segments = [t('ask '), c('bob'), t('- then\n- next')]
    expect(normalizeListPrefixes(segments, true)).toEqual([t('ask '), c('bob'), t('- then\n• next')])
  })

  it('counts lines across chips when finding fences', () => {
    const segments = [t('see '), c('bob'), t(' x\n```\n- code\n```\n- b')]
    expect(segmentsToPlainText(normalizeListPrefixes(segments, true))).toBe('see @bob x\n```\n- code\n```\n• b')
  })
})

describe('ordered-list renumbering', () => {
  it('rebuilds runs from 1 and restarts nested runs', () => {
    expect(renumberOrderedListLines('1. a\n1. b\n  5. c\n  9. d\n1. e').text).toBe('1. a\n2. b\n  1. c\n  2. d\n3. e')
  })

  it('returns the same text when nothing changes', () => {
    const text = '1. a\n2. b'
    expect(renumberOrderedListLines(text).text).toBe(text)
    expect(renumberOrderedListLines('no list').edits).toEqual([])
  })

  it('remaps offsets across resized numbers', () => {
    const { text, edits } = renumberOrderedListLines('9. a\n9. b\n9. c\n9. d\n9. e\n9. f\n9. g\n9. h\n9. i\n9. j')
    expect(text.endsWith('10. j')).toBe(true)
    const lastLineStart = '9. a\n'.length * 9
    expect(remapOffset(lastLineStart + 3, edits)).toBe(text.length - 1)
    expect(remapOffset(0, edits)).toBe(0)
  })

  it('applies edits to segments without touching chips', () => {
    const { segments } = renumberOrderedListSegments([t('1. '), c('bob'), t('\n1. b')])
    expect(segments).toEqual([t('1. '), c('bob'), t('\n2. b')])
  })

  it('tells a real list run from numeric prose', () => {
    expect(hasOrderedListRun('3. a\n4. b')).toBe(true)
    expect(hasOrderedListRun('1. a\n1. b')).toBe(true)
    expect(hasOrderedListRun('1985. Born\n2020. Died')).toBe(false)
    expect(hasOrderedListRun('1. only')).toBe(false)
  })
})
