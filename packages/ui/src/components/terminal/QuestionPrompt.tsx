import { useState } from 'react'
import type { PermissionRequest, UserQuestion } from '@workerdeck/protocol'
import { parseUserQuestions } from '../agent/QuestionPrompt.tsx'
import { Box, Choices, Hint, PromptInput, Rule, TabStrip, type Choice } from './prompt.tsx'
import { Blank, Ink, Row } from './row.tsx'

type Selection = { labels: string[]; other: string; otherActive: boolean }

const EMPTY: Selection = { labels: [], other: '', otherActive: false }

function answerFor(selection: Selection): string {
  const parts = [...selection.labels]
  if (selection.otherActive && selection.other.trim()) {
    parts.push(selection.other.trim())
  }
  return parts.join(', ')
}

export interface TerminalQuestionPromptProps {
  request: PermissionRequest
  onAnswer: (requestId: string, updatedInput: Record<string, unknown>) => void
  onDismiss: (requestId: string, message?: string) => void
  className?: string
}

export function TerminalQuestionPrompt({ request, onAnswer, onDismiss, className }: TerminalQuestionPromptProps) {
  const questions = parseUserQuestions(request.input)
  const [selections, setSelections] = useState<Selection[]>(() => questions.map(() => EMPTY))
  const [cursors, setCursors] = useState<number[]>(() => questions.map(() => 0))
  const [tab, setTab] = useState(0)
  const [reviewCursor, setReviewCursor] = useState(0)

  const review = tab >= questions.length
  const selection = selections[tab] ?? EMPTY
  const answered = (index: number) => answerFor(selections[index] ?? EMPTY) !== ''
  const complete = questions.every((_, index) => answered(index))

  const update = (index: number, patch: Partial<Selection>) =>
    setSelections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))

  const toggle = (index: number, label: string, multiSelect: boolean) => {
    setSelections((prev) =>
      prev.map((current, i) => {
        if (i !== index) {
          return current
        }
        if (!multiSelect) {
          return { ...current, labels: [label], otherActive: false }
        }
        return {
          ...current,
          labels: current.labels.includes(label) ? current.labels.filter((l) => l !== label) : [...current.labels, label],
        }
      }),
    )
  }

  const submit = () => {
    const answers: Record<string, string> = {}
    questions.forEach((question, index) => {
      answers[question.question] = answerFor(selections[index] ?? EMPTY)
    })
    onAnswer(request.id, { ...request.input, answers })
  }

  const dismiss = () => onDismiss(request.id, 'Question dismissed by user')

  const move = (delta: number) => setTab((current) => Math.min(questions.length, Math.max(0, current + delta)))

  return (
    <div
      data-slot="question-prompt"
      className={className}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          dismiss()
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          move(event.shiftKey ? -1 : 1)
        }
      }}
    >
      <Rule />
      <TabStrip
        tabs={[
          ...questions.map((question, index) => ({
            key: `q${index}`,
            label: question.header || `Question ${index + 1}`,
            glyph: answered(index) ? '▣' : '▢',
          })),
          { key: 'submit', label: 'Submit', glyph: '✓' },
        ]}
        active={tab}
        onSelect={setTab}
      />
      <Blank />
      {review ? (
        <ReviewStep
          questions={questions}
          answers={questions.map((_, index) => answerFor(selections[index] ?? EMPTY))}
          complete={complete}
          cursor={reviewCursor}
          onCursor={setReviewCursor}
          onSubmit={submit}
          onCancel={dismiss}
        />
      ) : (
        <QuestionStep
          // Keyed by question and load-bearing: without it React reuses the step across a Tab and the option list never re-arms its focus.
          key={tab}
          question={questions[tab]!}
          selection={selection}
          cursor={cursors[tab] ?? 0}
          onCursor={(next) => setCursors((prev) => prev.map((c, i) => (i === tab ? next : c)))}
          onToggle={(label) => toggle(tab, label, questions[tab]!.multiSelect === true)}
          onOther={(patch) => update(tab, patch)}
          onAdvance={() => move(1)}
          onDismiss={dismiss}
        />
      )}
      <Blank />
      <Hint>Enter to select · ↑/↓ to navigate · Tab to switch questions · Esc to cancel</Hint>
    </div>
  )
}

function QuestionStep({
  question,
  selection,
  cursor,
  onCursor,
  onToggle,
  onOther,
  onAdvance,
  onDismiss,
}: {
  question: UserQuestion
  selection: Selection
  cursor: number
  onCursor: (index: number) => void
  onToggle: (label: string) => void
  onOther: (patch: Partial<Selection>) => void
  onAdvance: () => void
  onDismiss: () => void
}) {
  const multiSelect = question.multiSelect === true

  const options: Choice[] = [
    ...question.options.map((option, index): Choice => {
      const selected = selection.labels.includes(option.label)
      return {
        key: option.label,
        label: option.label,
        description: option.description,
        checked: multiSelect ? selected : undefined,
        marker: 'check',
        selected: !multiSelect && selected,
        detail:
          option.preview && cursor === index ? (
            <Box>
              {option.preview.split('\n').map((line, row) => (
                <Row key={row} columns={0} tone="dim">
                  {line || ' '}
                </Row>
              ))}
            </Box>
          ) : undefined,
      }
    }),
    {
      key: '__other',
      label: 'Other…',
      checked: selection.otherActive,
      marker: 'check' as const,
      detail: selection.otherActive ? (
        <PromptInput
          value={selection.other}
          onChange={(value) => onOther({ other: value })}
          onSubmit={onAdvance}
          onCancel={() => onOther({ otherActive: false, other: '' })}
          placeholder="Type your own answer"
        />
      ) : undefined,
    },
    ...(multiSelect ? [{ key: '__next', label: 'Submit' }] : []),
    { key: '__chat', label: 'Chat about this' },
  ]

  return (
    <>
      <Row bold tone="bright">
        {question.question}
      </Row>
      <Blank />
      <Choices
        label={question.question}
        options={options}
        focused={cursor}
        active={!selection.otherActive}
        onFocus={onCursor}
        onChoose={(index) => {
          if (index < question.options.length) {
            onToggle(question.options[index]!.label)
            if (!multiSelect) {
              onAdvance()
            }
            return
          }
          if (index === question.options.length) {
            onOther({ otherActive: !selection.otherActive })
            return
          }
          if (multiSelect && index === question.options.length + 1) {
            onAdvance()
            return
          }
          onDismiss()
        }}
      />
    </>
  )
}

function ReviewStep({
  questions,
  answers,
  complete,
  cursor,
  onCursor,
  onSubmit,
  onCancel,
}: {
  questions: UserQuestion[]
  answers: string[]
  complete: boolean
  cursor: number
  onCursor: (index: number) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <>
      <Row bold tone="bright">
        Review your answers
      </Row>
      <Blank />
      {questions.map((question, index) => (
        <div key={index}>
          <Row glyph="●" glyphTone="dim">
            {question.question}
          </Row>
          <Row indent={1} glyph="→" glyphTone="green">
            <Ink tone={answers[index] ? 'green' : 'faint'}>{answers[index] || 'not answered'}</Ink>
          </Row>
        </div>
      ))}
      <Blank />
      <Row>{complete ? 'Ready to submit your answers?' : 'Some questions are unanswered.'}</Row>
      <Choices
        label="Submit answers"
        options={[
          { key: 'submit', label: complete ? 'Submit answers' : 'Submit anyway' },
          { key: 'cancel', label: 'Cancel', danger: true },
        ]}
        focused={cursor}
        onFocus={onCursor}
        onChoose={(index) => (index === 0 ? onSubmit() : onCancel())}
      />
    </>
  )
}
