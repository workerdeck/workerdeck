import { CircleCheck, CircleSlash, Lock, MessageCircleQuestion } from 'lucide-react'
import { forwardRef } from 'react'
import { questionAnswerLine, type QuestionItem } from '@workerdeck/protocol'
import { formatRelativeTime } from '../../lib/format.ts'
import { cn } from '../../lib/utils.ts'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import { Response } from './Response.tsx'

export type QuestionInput = { choice?: string; text: string }

export interface QuestionCardProps {
  item: QuestionItem
  input?: QuestionInput
  focused?: boolean
  busy?: boolean
  error?: string
  onPick?: (choice: string | undefined) => void
  onText?: (text: string) => void
  onSubmit?: () => void
  onClose?: () => void
  onFocus?: () => void
  onOpenLink?: (link: string) => void
  className?: string
}

const SUBMIT_LABEL: Record<QuestionItem['kind'], string> = { decision: 'Answer', action: 'Done', fyi: 'Seen' }

// What an empty submit sends: the gateway needs a choice or text, and confirming an action or an fyi has neither.
export const QUESTION_EMPTY_ANSWER: Record<QuestionItem['kind'], string | undefined> = { decision: undefined, action: 'done', fyi: 'seen' }

export const QuestionCard = forwardRef<HTMLTextAreaElement, QuestionCardProps>(function QuestionCard(
  { item, input, focused, busy, error, onPick, onText, onSubmit, onClose, onFocus, onOpenLink, className },
  textRef,
) {
  const live = item.status === 'open'
  const choice = input?.choice
  const text = input?.text ?? ''
  const canSubmit = live && !busy && (item.kind !== 'decision' || !!choice || text.trim() !== '')

  return (
    <article
      data-slot="question-card"
      data-focused={focused ? '' : undefined}
      onMouseDown={onFocus}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-bg p-3 transition-colors',
        focused ? 'border-accent' : 'border-border',
        item.status === 'draft' && 'opacity-70',
        className,
      )}
    >
      <header className="flex items-start gap-2">
        <StatusGlyph item={item} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-body font-medium text-fg-1">
            <span className="mr-1.5 font-mono text-fg-4">#{item.n}</span>
            {item.title}
          </h3>
          <div className="flex flex-wrap items-center gap-1.5 text-label text-fg-4">
            <Badge variant={item.kind === 'action' ? 'warning' : item.kind === 'fyi' ? 'neutral' : 'info'}>{item.kind}</Badge>
            {item.status === 'draft' ? <Badge>draft, with the lead</Badge> : null}
            {item.blocking && (live || item.status === 'draft') ? (
              <Badge variant="danger" title={item.blocking}>
                <Lock className="size-3" />
                blocking: {item.blocking}
              </Badge>
            ) : null}
            <span>{item.askerName ?? item.asker}</span>
            <span>{formatRelativeTime(item.createdAt)}</span>
            {item.parent ? <span>follow-up of #{item.parent}</span> : null}
            {item.waiting.length > 0 ? <span>{item.waiting.length} more waiting</span> : null}
          </div>
        </div>
      </header>

      {item.context ? <Response className="text-body-sm text-fg-2">{item.context}</Response> : null}

      {item.links?.length ? (
        <ul className="flex flex-col gap-0.5 text-body-sm">
          {item.links.map((link) => (
            <li key={link} className="truncate">
              {onOpenLink ? (
                <button type="button" className="font-mono text-code text-accent hover:underline" onClick={() => onOpenLink(link)}>
                  {link}
                </button>
              ) : (
                <span className="font-mono text-code text-fg-3">{link}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {item.options?.length ? (
        <div className="flex flex-col gap-1.5" role={live ? 'radiogroup' : undefined}>
          {item.options.map((option, index) => {
            const recommended = item.recommendation?.choice === option.key
            const picked = live ? choice === option.key : item.answer?.choice === option.key
            return (
              <button
                key={option.key}
                type="button"
                role={live ? 'radio' : undefined}
                aria-checked={live ? picked : undefined}
                disabled={!live || busy}
                onClick={() => onPick?.(picked ? undefined : option.key)}
                className={cn(
                  'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-default',
                  picked ? 'border-accent bg-accent-bg' : 'border-border',
                  live && !picked && 'hover:border-border-strong hover:bg-surface',
                )}
              >
                {live && index < 9 ? <span className="mt-px font-mono text-code text-fg-4">{index + 1}</span> : null}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body-sm font-medium text-fg-1">
                    {option.key !== String(index + 1) ? <span className="mr-1.5 text-fg-3">{option.key}</span> : null}
                    {option.label}
                    {recommended ? (
                      <Badge variant="success" className="ml-2 align-middle">
                        recommended
                      </Badge>
                    ) : null}
                  </span>
                  {option.detail ? <span className="text-label text-fg-4">{option.detail}</span> : null}
                </span>
              </button>
            )
          })}
          {item.recommendation?.why ? <p className="text-label text-fg-4">Why: {item.recommendation.why}</p> : null}
        </div>
      ) : null}

      {live ? (
        <div className="flex flex-col gap-2">
          <Textarea
            ref={textRef}
            rows={1}
            value={text}
            disabled={busy}
            onChange={(event) => onText?.(event.target.value)}
            onFocus={onFocus}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) {
                event.preventDefault()
                onSubmit?.()
              } else if (event.key === 'Escape') {
                event.currentTarget.blur()
              }
            }}
            placeholder={item.options?.length ? 'Add a note, or answer in your own words' : 'Your answer'}
            className="max-h-48 overflow-y-auto py-1.5 field-sizing-content"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
              {SUBMIT_LABEL[item.kind]}
            </Button>
            {onClose ? (
              <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
                Close without answer
              </Button>
            ) : null}
            {error ? <span className="text-label text-danger">{error}</span> : null}
          </div>
        </div>
      ) : null}

      {item.status === 'answered' && item.answer ? (
        <p className="text-body-sm text-fg-2">
          <span className="text-fg-4">
            Answered by {item.answer.by} {formatRelativeTime(item.answer.at)}:{' '}
          </span>
          {questionAnswerLine(item) || 'acknowledged'}
        </p>
      ) : null}
      {item.status === 'closed' && item.closed ? (
        <p className="text-body-sm text-fg-3">
          Closed ({item.closed.reason}
          {item.closed.supersededBy ? ` by #${item.closed.supersededBy}` : ''}) by {item.closed.by} {formatRelativeTime(item.closed.at)}
          {item.closed.note ? `: ${item.closed.note}` : ''}
        </p>
      ) : null}
    </article>
  )
})

function StatusGlyph({ item }: { item: QuestionItem }) {
  if (item.status === 'answered') {
    return <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
  }
  if (item.status === 'closed') {
    return <CircleSlash className="mt-0.5 size-4 shrink-0 text-fg-4" />
  }
  return <MessageCircleQuestion className={cn('mt-0.5 size-4 shrink-0', item.blocking ? 'text-danger' : 'text-info')} />
}
