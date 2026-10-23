import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  errorMessage,
  questionBoardView,
  questionMatches,
  type AnswerQuestionRequest,
  type CloseQuestionRequest,
  type QuestionItem,
  type QuestionResponse,
} from '@workerdeck/protocol'
import { cn } from '../../lib/utils.ts'
import { Input } from '../ui/Input.tsx'
import { QUESTION_EMPTY_ANSWER, QuestionCard, type QuestionInput } from './QuestionCard.tsx'

export type QuestionBoardTab = 'open' | 'answered' | 'closed'

export interface QuestionBoardProps {
  items: readonly QuestionItem[]
  onAnswer: (n: number, request: AnswerQuestionRequest) => Promise<QuestionResponse>
  onClose: (n: number, request: CloseQuestionRequest) => Promise<QuestionResponse>
  onOpenLink?: (link: string, item: QuestionItem) => void
  className?: string
}

export function QuestionBoard({ items, onAnswer, onClose, onOpenLink, className }: QuestionBoardProps) {
  const view = useMemo(() => questionBoardView(items), [items])
  const [tab, setTab] = useState<QuestionBoardTab>('open')
  const [search, setSearch] = useState('')
  const [inputs, setInputs] = useState<Record<number, QuestionInput>>({})
  const [busy, setBusy] = useState<number | undefined>()
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [focused, setFocused] = useState<number | undefined>()
  const cards = useRef(new Map<number, HTMLElement>())
  const texts = useRef(new Map<number, HTMLTextAreaElement>())

  const openItems = useMemo(() => view.open.flatMap((round) => round.items), [view])
  const focusedItem = openItems.find((item) => item.n === focused)

  useEffect(() => {
    if (tab === 'open' && openItems.length > 0 && !focusedItem) {
      setFocused(openItems[0]!.n)
    }
  }, [tab, openItems, focusedItem])

  useEffect(() => {
    if (focused !== undefined) {
      cards.current.get(focused)?.scrollIntoView({ block: 'nearest' })
    }
  }, [focused])

  const inputOf = (n: number): QuestionInput => inputs[n] ?? { text: '' }
  const setDraft = (n: number, patch: Partial<QuestionInput>) => setInputs((current) => ({ ...current, [n]: { ...inputOf(n), ...patch } }))

  const run = async (n: number, action: () => Promise<unknown>) => {
    setBusy(n)
    setErrors((current) => without(current, n))
    try {
      await action()
      setInputs((current) => without(current, n))
    } catch (error) {
      setErrors((current) => ({ ...current, [n]: errorMessage(error, 'The gateway refused it') }))
    } finally {
      setBusy(undefined)
    }
  }

  const submit = (item: QuestionItem) => {
    const input = inputOf(item.n)
    const text = input.text.trim() || (input.choice ? '' : QUESTION_EMPTY_ANSWER[item.kind])
    if (!input.choice && !text) {
      return
    }
    void run(item.n, () => onAnswer(item.n, { ...(input.choice ? { choice: input.choice } : {}), ...(text ? { text } : {}) }))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (tab !== 'open' || event.metaKey || event.ctrlKey || event.altKey || target.closest('textarea, input')) {
      return
    }
    const index = openItems.findIndex((item) => item.n === focused)
    if (event.key === 'j' || event.key === 'k') {
      const next = openItems[Math.max(0, Math.min(openItems.length - 1, index + (event.key === 'j' ? 1 : -1)))]
      if (next) {
        event.preventDefault()
        setFocused(next.n)
      }
      return
    }
    if (!focusedItem) {
      return
    }
    if (/^[1-9]$/.test(event.key)) {
      const option = focusedItem.options?.[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        setDraft(focusedItem.n, { choice: inputOf(focusedItem.n).choice === option.key ? undefined : option.key })
      }
    } else if (event.key === 'e') {
      event.preventDefault()
      texts.current.get(focusedItem.n)?.focus()
    } else if (event.key === 'Enter' && target.tagName !== 'BUTTON') {
      event.preventDefault()
      submit(focusedItem)
    }
  }

  const card = (item: QuestionItem, live: boolean) => (
    <div
      key={item.n}
      ref={(element) => {
        if (element) {
          cards.current.set(item.n, element)
        } else {
          cards.current.delete(item.n)
        }
      }}
    >
      <QuestionCard
        ref={(element) => {
          if (element) {
            texts.current.set(item.n, element)
          } else {
            texts.current.delete(item.n)
          }
        }}
        item={item}
        input={inputOf(item.n)}
        focused={live && focused === item.n}
        busy={busy === item.n}
        error={errors[item.n]}
        onFocus={live ? () => setFocused(item.n) : undefined}
        onPick={(choice) => setDraft(item.n, { choice })}
        onText={(text) => setDraft(item.n, { text })}
        onSubmit={() => submit(item)}
        onClose={live ? () => void run(item.n, () => onClose(item.n, { reason: 'resolved' })) : undefined}
        onOpenLink={onOpenLink}
      />
    </div>
  )

  const past = (tab === 'answered' ? view.answered : view.closed).filter((item) => questionMatches(item, search))
  const tabs: Array<[QuestionBoardTab, string, number]> = [
    ['open', 'Open', openItems.length],
    ['answered', 'Answered', view.answered.length],
    ['closed', 'Closed', view.closed.length],
  ]

  return (
    <div data-slot="question-board" tabIndex={-1} onKeyDown={onKeyDown} className={cn('flex flex-col gap-4 outline-none', className)}>
      <div className="flex flex-wrap items-center gap-1" role="tablist">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'rounded-md px-2.5 py-1 text-body-sm transition-colors',
              tab === key ? 'bg-surface font-medium text-fg-1' : 'text-fg-3 hover:bg-surface hover:text-fg-1',
            )}
          >
            {label}
            <span className="ml-1.5 text-fg-4">{count}</span>
          </button>
        ))}
        {tab === 'open' && openItems.length > 0 ? (
          <span className="ml-auto text-label whitespace-nowrap text-fg-4">j/k move, 1-9 pick, e note, Enter answer</span>
        ) : null}
      </div>

      {tab === 'open' ? (
        <>
          {openItems.length === 0 ? <p className="text-body-sm text-fg-3">Nothing open.</p> : null}
          {view.open.map((round) => (
            <section key={round.round ?? ''} className="flex flex-col gap-3">
              {round.round ? <h2 className="text-label font-medium tracking-wide text-fg-4 uppercase">{round.round}</h2> : null}
              {round.items.map((item) => card(item, true))}
            </section>
          ))}
        </>
      ) : (
        <>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by #n, title or answer" />
          {past.length === 0 ? <p className="text-body-sm text-fg-3">{search ? 'No match.' : 'Nothing here yet.'}</p> : null}
          {past.map((item) => card(item, false))}
        </>
      )}
    </div>
  )
}

function without<T>(record: Record<number, T>, n: number): Record<number, T> {
  const next = { ...record }
  delete next[n]
  return next
}
