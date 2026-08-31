import { useState } from 'react'
import type { PermissionRequest, QuestionBehavior, UserQuestion, UserQuestionOption } from '@workerdeck/protocol'
import { MessageCircleQuestion, X } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { cn } from '../../lib/utils.ts'

export type QuestionBehaviorMeta = {
  value: QuestionBehavior
  label: string
  description: string
}

export const QUESTION_BEHAVIORS: QuestionBehaviorMeta[] = [
  { value: 'auto', label: 'Auto-answer', description: 'pick each question’s recommended option' },
  { value: 'ask', label: 'Ask', description: 'wait for a watcher or webhook controller to answer' },
  { value: 'deny', label: 'Disabled', description: 'the agent is told to decide on its own' },
]

export function parseUserQuestions(input: Record<string, unknown>): UserQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw.flatMap((entry): UserQuestion[] => {
    const q = entry as Partial<UserQuestion>
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) {
      return []
    }
    const options = q.options.filter((o): o is UserQuestionOption => typeof (o as UserQuestionOption | undefined)?.label === 'string')
    if (options.length === 0) {
      return []
    }
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

const EMPTY_SELECTION: Selection = { labels: [], other: '', otherActive: false }

function answerFor(selection: Selection): string {
  const parts = [...selection.labels]
  if (selection.otherActive && selection.other.trim()) {
    parts.push(selection.other.trim())
  }
  return parts.join(', ')
}

export interface QuestionPromptProps {
  request: PermissionRequest
  onAnswer: (requestId: string, updatedInput: Record<string, unknown>) => void
  onDismiss: (requestId: string, message?: string) => void
  className?: string
}

export function QuestionPrompt({ request, onAnswer, onDismiss, className }: QuestionPromptProps) {
  const questions = parseUserQuestions(request.input)
  const [selections, setSelections] = useState<Selection[]>(() => questions.map(() => EMPTY_SELECTION))

  const update = (index: number, patch: Partial<Selection>) => {
    setSelections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const toggle = (index: number, label: string, multiSelect: boolean) => {
    const current = selections[index] ?? EMPTY_SELECTION
    if (multiSelect) {
      update(index, {
        labels: current.labels.includes(label) ? current.labels.filter((l) => l !== label) : [...current.labels, label],
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

  return (
    <div data-slot="question-prompt" className={cn('rounded-lg border border-info/40 bg-info-bg p-3', className)}>
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {questions.map((q, index) => {
            const selection = selections[index] ?? EMPTY_SELECTION
            return (
              <div key={index} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  {q.header ? <Badge variant="info">{q.header}</Badge> : null}
                  <span className="text-body-sm font-medium text-fg-1">{q.question}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {q.options.map((option) => {
                    const selected = selection.labels.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        onClick={() => toggle(index, option.label, q.multiSelect === true)}
                        className={cn(
                          'rounded-md border px-2.5 py-1.5 text-left transition-colors',
                          selected ? 'border-info bg-bg' : 'border-border bg-bg/50 hover:border-border-strong hover:bg-bg',
                        )}
                      >
                        <span className="block text-body-sm font-medium text-fg-1">{option.label}</span>
                        {option.description ? <span className="block text-label text-fg-4">{option.description}</span> : null}
                        {selected && option.preview ? (
                          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-code-bg px-2.5 py-1.5 font-mono text-label whitespace-pre-wrap text-fg-2">
                            {option.preview}
                          </pre>
                        ) : null}
                      </button>
                    )
                  })}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => update(index, { otherActive: !selection.otherActive })}
                      className={cn(
                        'shrink-0 rounded-md border px-2.5 py-1.5 text-body-sm font-medium transition-colors',
                        selection.otherActive
                          ? 'border-info bg-bg text-fg-1'
                          : 'border-border bg-bg/50 text-fg-3 hover:border-border-strong hover:bg-bg',
                      )}
                    >
                      Other…
                    </button>
                    {selection.otherActive ? (
                      <Input
                        autoFocus
                        value={selection.other}
                        onChange={(e) => update(index, { other: e.target.value })}
                        placeholder="Type your own answer"
                        className="flex-1"
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
          <div>
            <Button size="sm" onClick={submit} disabled={!complete}>
              Answer
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss question"
          className="shrink-0"
          onClick={() => onDismiss(request.id, 'Question dismissed by user')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
