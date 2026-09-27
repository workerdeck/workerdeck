import { useState } from 'react'
import type { UserQuestion } from '@workerdeck/protocol'

export type Selection = { labels: string[]; other: string; otherActive: boolean }

export const EMPTY_SELECTION: Selection = { labels: [], other: '', otherActive: false }

export function answerFor(selection: Selection): string {
  const parts = [...selection.labels]
  if (selection.otherActive && selection.other.trim()) {
    parts.push(selection.other.trim())
  }
  return parts.join(', ')
}

export function toggleLabel(selection: Selection, label: string, multiSelect: boolean): Selection {
  if (!multiSelect) {
    return { ...selection, labels: [label], otherActive: false }
  }
  const labels = selection.labels.includes(label) ? selection.labels.filter((l) => l !== label) : [...selection.labels, label]
  return { ...selection, labels }
}

export function toggleOther(selection: Selection, multiSelect: boolean): Selection {
  const otherActive = !selection.otherActive
  return { ...selection, otherActive, labels: otherActive && !multiSelect ? [] : selection.labels }
}

export function answersFor(questions: readonly UserQuestion[], selections: readonly Selection[]): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((question, index) => {
    answers[question.question] = answerFor(selections[index] ?? EMPTY_SELECTION)
  })
  return answers
}

export interface QuestionAnswers {
  selections: Selection[]
  selectionFor: (index: number) => Selection
  answered: (index: number) => boolean
  complete: boolean
  update: (index: number, patch: Partial<Selection>) => void
  toggle: (index: number, label: string) => void
  toggleOther: (index: number) => void
  answers: () => Record<string, string>
}

export function useQuestionAnswers(questions: readonly UserQuestion[]): QuestionAnswers {
  const [selections, setSelections] = useState<Selection[]>(() => questions.map(() => EMPTY_SELECTION))
  const selectionFor = (index: number) => selections[index] ?? EMPTY_SELECTION
  const answered = (index: number) => answerFor(selectionFor(index)) !== ''
  const edit = (index: number, change: (selection: Selection) => Selection) =>
    setSelections((prev) => questions.map((_, i) => (i === index ? change(prev[i] ?? EMPTY_SELECTION) : (prev[i] ?? EMPTY_SELECTION))))
  const multiSelect = (index: number) => questions[index]?.multiSelect === true
  return {
    selections,
    selectionFor,
    answered,
    complete: questions.every((_, index) => answered(index)),
    update: (index, patch) => edit(index, (selection) => ({ ...selection, ...patch })),
    toggle: (index, label) => edit(index, (selection) => toggleLabel(selection, label, multiSelect(index))),
    toggleOther: (index) => edit(index, (selection) => toggleOther(selection, multiSelect(index))),
    answers: () => answersFor(questions, selections),
  }
}
