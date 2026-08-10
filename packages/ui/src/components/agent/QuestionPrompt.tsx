import { useState } from 'react'
import type {
  PermissionRequest,
  QuestionBehavior,
  UserQuestion,
  UserQuestionOption,
} from '@workerdeck/protocol'
import { MessageCircleQuestion, X } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { cn } from '../../lib/utils.ts'
import { LINE_INDENT, LineHint, LineInput, LineOptionList, LinePayload } from './line-prompt.tsx'
import { LineGlyph, useLines } from './transcript-variant.tsx'

export type QuestionBehaviorMeta = {
  value: QuestionBehavior
  label: string
  description: string
}

/** The AskUserQuestion policies surfaced on job/session creation forms. */
export const QUESTION_BEHAVIORS: QuestionBehaviorMeta[] = [
  { value: 'auto', label: 'Auto-answer', description: 'pick each question’s recommended option' },
  { value: 'ask', label: 'Ask', description: 'wait for a watcher or webhook controller to answer' },
  { value: 'deny', label: 'Disabled', description: 'the agent is told to decide on its own' },
]

/** Extract well-formed questions from an AskUserQuestion permission request's input. */
export function parseUserQuestions(input: Record<string, unknown>): UserQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw.flatMap((entry): UserQuestion[] => {
    const q = entry as Partial<UserQuestion>
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) return []
    const options = q.options.filter(
      (o): o is UserQuestionOption => typeof (o as UserQuestionOption | undefined)?.label === 'string',
    )
    if (options.length === 0) return []
    return [
      {
        question: q.question,
        header: typeof q.header === 'string' ? q.header : '',
        options,
        multiSelect: q.multiSelect === true,
      },
    ]
  })
}

type Selection = { labels: string[]; other: string; otherActive: boolean }

/** Whether the key hint should say "toggle" rather than "choose". */
const multiSelectAnywhere = (questions: UserQuestion[]) => questions.some((q) => q.multiSelect === true)

const EMPTY_SELECTION: Selection = { labels: [], other: '', otherActive: false }

/** A question's answer string: chosen label(s) (multi-select comma-joined), with any
 * free-text "Other" appended — the value the CLI expects in `updatedInput.answers`. */
function answerFor(selection: Selection): string {
  const parts = [...selection.labels]
  if (selection.otherActive && selection.other.trim()) parts.push(selection.other.trim())
  return parts.join(', ')
}

export interface QuestionPromptProps {
  /** A pending permission whose toolName is 'AskUserQuestion'. */
  request: PermissionRequest
  /** Allow the tool with `updatedInput` (the original input plus `answers`). */
  onAnswer: (requestId: string, updatedInput: Record<string, unknown>) => void
  /** Deny the tool — the model proceeds without an answer. */
  onDismiss: (requestId: string, message?: string) => void
  className?: string
}

/** Interactive form for the AskUserQuestion tool: option buttons per question
 * (multi-select where the question allows it), a free-text "Other" escape hatch,
 * and the focused option's preview. Falls back to nothing renderable → the caller
 * should show a generic PermissionPrompt if `parseUserQuestions` finds no questions. */
export function QuestionPrompt({ request, onAnswer, onDismiss, className }: QuestionPromptProps) {
  const lines = useLines()
  const questions = parseUserQuestions(request.input)
  const [selections, setSelections] = useState<Selection[]>(() =>
    questions.map(() => EMPTY_SELECTION),
  )
  // `lines` only: the roving cursor per question, and which question's list owns
  // the DOM focus — two lists both chasing their own index would tear the caret
  // between them on every render.
  const [cursors, setCursors] = useState<number[]>(() => questions.map(() => 0))
  const [activeQuestion, setActiveQuestion] = useState(0)

  const update = (index: number, patch: Partial<Selection>) => {
    setSelections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const toggle = (index: number, label: string, multiSelect: boolean) => {
    const current = selections[index] ?? EMPTY_SELECTION
    if (multiSelect) {
      update(index, {
        labels: current.labels.includes(label)
          ? current.labels.filter((l) => l !== label)
          : [...current.labels, label],
      })
    } else {
      update(index, { labels: current.labels[0] === label ? [] : [label], otherActive: false })
    }
  }

  const complete = questions.every((_, i) => answerFor(selections[i] ?? EMPTY_SELECTION) !== '')

  const submit = () => {
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(selections[i] ?? EMPTY_SELECTION)
    })
    onAnswer(request.id, { ...request.input, answers })
  }

  if (lines) {
    const dismiss = () => onDismiss(request.id, 'Question dismissed by user')
    return (
      <div
        data-slot='question-prompt'
        className={cn('flex w-full flex-col gap-2', className)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            dismiss()
            return
          }
          // Enter belongs to the focused row (it is a button), so committing the
          // whole form needs the modifier — the composer's own convention.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && complete) {
            event.preventDefault()
            submit()
          }
        }}>
        {questions.map((q, index) => {
          const selection = selections[index] ?? EMPTY_SELECTION
          const cursor = cursors[index] ?? 0
          const multiSelect = q.multiSelect === true
          const options = [
            ...q.options.map((option, optionIndex) => {
              const selected = selection.labels.includes(option.label)
              return {
                key: option.label,
                label: option.label,
                description: option.description,
                // A preview shows on focus, not only on selection: in a list you
                // walk with the arrow keys, "what does this one look like" is the
                // question the cursor is asking.
                detail:
                  option.preview && (selected || cursor === optionIndex) ? (
                    <LinePayload code={option.preview} label='Preview' />
                  ) : undefined,
                // Both kinds draw their state: without a marker a chosen
                // one-of is invisible the moment the cursor moves off it.
                checked: selected,
                marker: multiSelect ? ('check' as const) : ('radio' as const),
              }
            }),
            {
              key: '__other',
              label: 'Other…',
              checked: selection.otherActive,
              marker: multiSelect ? ('check' as const) : ('radio' as const),
              detail: selection.otherActive ? (
                <LineInput
                  value={selection.other}
                  onChange={(value) => update(index, { other: value })}
                  onSubmit={() => {
                    // The typed text is already in state, so `complete` is
                    // current: Enter finishes the form when this was the last
                    // question outstanding, and is a no-op when it wasn't.
                    if (complete) submit()
                  }}
                  onCancel={() => update(index, { otherActive: false, other: '' })}
                  placeholder='Type your own answer'
                />
              ) : undefined,
            },
          ]
          return (
            <div key={index} className='flex flex-col'>
              <div className='flex items-baseline gap-2'>
                <LineGlyph className='text-info'>?</LineGlyph>
                <span className='min-w-0 flex-1 text-body-sm leading-5 text-fg-1'>
                  {q.header ? <span className='text-fg-4'>{q.header} · </span> : null}
                  <span className='font-medium'>{q.question}</span>
                </span>
              </div>
              <LineOptionList
                label={q.question}
                options={options}
                focused={cursor}
                active={activeQuestion === index && !selection.otherActive}
                onFocus={(next) => {
                  setActiveQuestion(index)
                  setCursors((prev) => prev.map((c, i) => (i === index ? next : c)))
                }}
                onChoose={(next) => {
                  if (next === q.options.length) {
                    update(index, { otherActive: !selection.otherActive })
                    return
                  }
                  const option = q.options[next]
                  if (option) toggle(index, option.label, multiSelect)
                }}
              />
            </div>
          )
        })}
        <div className={cn(LINE_INDENT, 'flex flex-col')}>
          <button
            type='button'
            disabled={!complete}
            onClick={submit}
            className='w-fit text-body-sm leading-5 text-accent underline-offset-2 outline-none hover:underline disabled:text-fg-4 disabled:no-underline'>
            ⏎ Answer
          </button>
        </div>
        <LineHint>
          ↑↓ move · {multiSelectAnywhere(questions) ? 'space/1–9 toggle' : '1–9 choose'} · ⌘⏎ answer
          · esc dismiss
        </LineHint>
      </div>
    )
  }

  return (
    <div
      data-slot='question-prompt'
      className={cn('rounded-lg border border-info/40 bg-info-bg p-3', className)}>
      <div className='flex items-start gap-2.5'>
        <MessageCircleQuestion className='mt-0.5 size-4 shrink-0 text-info' />
        <div className='flex min-w-0 flex-1 flex-col gap-3'>
          {questions.map((q, index) => {
            const selection = selections[index] ?? EMPTY_SELECTION
            return (
              <div key={index} className='flex flex-col gap-1.5'>
                <div className='flex items-center gap-2'>
                  {q.header ? <Badge variant='info'>{q.header}</Badge> : null}
                  <span className='text-body-sm font-medium text-fg-1'>{q.question}</span>
                </div>
                <div className='flex flex-col gap-1'>
                  {q.options.map((option) => {
                    const selected = selection.labels.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type='button'
                        onClick={() => toggle(index, option.label, q.multiSelect === true)}
                        className={cn(
                          'rounded-md border px-2.5 py-1.5 text-left transition-colors',
                          selected
                            ? 'border-info bg-bg'
                            : 'border-border bg-bg/50 hover:border-border-strong hover:bg-bg',
                        )}>
                        <span className='block text-body-sm font-medium text-fg-1'>
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className='block text-label text-fg-4'>{option.description}</span>
                        ) : null}
                        {selected && option.preview ? (
                          <pre className='mt-1.5 max-h-40 overflow-auto rounded-md bg-code-bg px-2.5 py-1.5 font-mono text-label whitespace-pre-wrap text-fg-2'>
                            {option.preview}
                          </pre>
                        ) : null}
                      </button>
                    )
                  })}
                  <div className='flex items-center gap-2'>
                    <button
                      type='button'
                      onClick={() => update(index, { otherActive: !selection.otherActive })}
                      className={cn(
                        'shrink-0 rounded-md border px-2.5 py-1.5 text-body-sm font-medium transition-colors',
                        selection.otherActive
                          ? 'border-info bg-bg text-fg-1'
                          : 'border-border bg-bg/50 text-fg-3 hover:border-border-strong hover:bg-bg',
                      )}>
                      Other…
                    </button>
                    {selection.otherActive ? (
                      <Input
                        autoFocus
                        value={selection.other}
                        onChange={(e) => update(index, { other: e.target.value })}
                        placeholder='Type your own answer'
                        className='flex-1'
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
          <div>
            <Button size='sm' onClick={submit} disabled={!complete}>
              Answer
            </Button>
          </div>
        </div>
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label='Dismiss question'
          className='shrink-0'
          onClick={() => onDismiss(request.id, 'Question dismissed by user')}>
          <X className='size-3.5' />
        </Button>
      </div>
    </div>
  )
}
