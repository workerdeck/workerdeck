import { describe, expect, it } from 'vitest'
import type { UserQuestion } from '@workerdeck/protocol'
import { answerFor, answersFor, EMPTY_SELECTION, toggleLabel, toggleOther, type Selection } from '../src/lib/question-answers.ts'

function question(text: string, multiSelect = false): UserQuestion {
  return { question: text, header: '', options: [{ label: 'A' }, { label: 'B' }], multiSelect }
}

describe('toggleLabel', () => {
  it('keeps a single-select answer chosen when the same option is picked again', () => {
    const once = toggleLabel(EMPTY_SELECTION, 'A', false)
    expect(toggleLabel(once, 'A', false).labels).toEqual(['A'])
    expect(toggleLabel(once, 'B', false).labels).toEqual(['B'])
  })

  it('drops the typed answer when a single-select option is picked', () => {
    const typing: Selection = { labels: [], other: 'mine', otherActive: true }
    expect(toggleLabel(typing, 'A', false)).toEqual({ labels: ['A'], other: 'mine', otherActive: false })
  })

  it('adds and removes multi-select options independently', () => {
    const both = toggleLabel(toggleLabel(EMPTY_SELECTION, 'A', true), 'B', true)
    expect(both.labels).toEqual(['A', 'B'])
    expect(toggleLabel(both, 'A', true).labels).toEqual(['B'])
  })
})

describe('toggleOther', () => {
  it('replaces a single-select option rather than adding to it', () => {
    const picked = toggleLabel(EMPTY_SELECTION, 'A', false)
    expect(toggleOther(picked, false)).toEqual({ labels: [], other: '', otherActive: true })
  })

  it('sits beside multi-select options', () => {
    const picked = toggleLabel(EMPTY_SELECTION, 'A', true)
    expect(toggleOther(picked, true).labels).toEqual(['A'])
  })
})

describe('answerFor', () => {
  it('joins options and the typed answer, ignoring an empty or inactive one', () => {
    expect(answerFor({ labels: ['A', 'B'], other: ' x ', otherActive: true })).toBe('A, B, x')
    expect(answerFor({ labels: ['A'], other: 'x', otherActive: false })).toBe('A')
    expect(answerFor({ labels: [], other: '  ', otherActive: true })).toBe('')
  })
})

describe('answersFor', () => {
  it('keys each answer by its question, empty for an unanswered one', () => {
    const questions = [question('Which?'), question('Also?', true)]
    expect(answersFor(questions, [toggleLabel(EMPTY_SELECTION, 'B', false)])).toEqual({ 'Which?': 'B', 'Also?': '' })
  })
})
