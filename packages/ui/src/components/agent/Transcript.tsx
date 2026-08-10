import { Fragment, useEffect, useMemo, useState } from 'react'
import type { MessageAttachment } from '@workerdeck/protocol'
import { recapLine, summarizeSince, type TranscriptItem, type TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatDuration, formatRelativeTime } from '../../lib/format.ts'
import { Conversation, ConversationContent, ConversationScrollButton } from './Conversation.tsx'
import { FileCard } from './FileCard.tsx'
import { Loader } from './Loader.tsx'
import { Message, MessageContent } from './Message.tsx'
import { PromptTokenText } from './PromptTokenText.tsx'
import { Reasoning } from './Reasoning.tsx'
import { Response } from './Response.tsx'
import { SessionEmptyState } from './SessionEmptyState.tsx'
import { ToolCallCard } from './ToolCallCard.tsx'
import {
  LineGlyph,
  TranscriptVariantProvider,
  useLines,
  type TranscriptVariant,
} from './transcript-variant.tsx'

function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
  const lines = useLines()
  if (lines) {
    // One dim line, no rules: the turn's end is a footnote, not a divider that
    // costs three rows of vertical space.
    return (
      <div data-slot='turn-result' className='flex items-baseline gap-2'>
        <LineGlyph className='text-fg-4'>·</LineGlyph>
        <div className='min-w-0 flex-1'>
          <span className={cn('text-label leading-5', item.isError ? 'text-danger' : 'text-fg-4')}>
            {item.isError ? item.subtype : 'turn done'} · {formatDuration(item.durationMs)} ·{' '}
            {formatCost(item.totalCostUsd)}
          </span>
          {item.errors?.length ? (
            <ul className='flex flex-col'>
              {item.errors.map((message, index) => (
                <li key={index} className='text-label leading-5 break-words text-danger'>
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div data-slot='turn-result' className='py-1'>
      <div className='flex items-center gap-2'>
        <div className='h-px flex-1 bg-border' />
        <span className={cn('font-mono text-label', item.isError ? 'text-danger' : 'text-fg-4')}>
          {item.isError ? item.subtype : 'turn done'} · {formatDuration(item.durationMs)} ·{' '}
          {formatCost(item.totalCostUsd)}
        </span>
        <div className='h-px flex-1 bg-border' />
      </div>
      {/* A failed turn's reasons are the whole point of the row — dropping them
          leaves "error_during_execution" and nothing to act on. */}
      {item.errors?.length ? (
        <ul className='mt-1 flex flex-col gap-0.5 text-center'>
          {item.errors.map((message, index) => (
            <li key={index} className='text-label break-words text-danger'>
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function NoticeRow({ item }: { item: Extract<TranscriptItem, { kind: 'notice' }> }) {
  const lines = useLines()
  if (lines) {
    return (
      <div data-slot='notice' className='flex items-baseline gap-2'>
        <LineGlyph className={item.level === 'error' ? 'text-danger' : 'text-fg-4'}>!</LineGlyph>
        <span
          className={cn(
            'min-w-0 flex-1 text-body-sm leading-5',
            item.level === 'error' ? 'text-danger' : 'text-fg-3',
          )}>
          {item.text}
        </span>
      </div>
    )
  }
  return (
    <div
      data-slot='notice'
      className={cn(
        'rounded-md border px-3 py-2 text-body-sm',
        item.level === 'error'
          ? 'border-transparent bg-danger-bg text-danger'
          : 'border-border bg-surface text-fg-3',
      )}>
      {item.text}
    </div>
  )
}

function TranscriptItemView({
  item,
  fileUrl,
  attachmentUrl,
  hostImage,
}: {
  item: TranscriptItem
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  hostImage?: (path: string) => Promise<string | undefined>
}) {
  switch (item.kind) {
    case 'user':
      return (
        <Message from='user'>
          {item.attachments?.length ? (
            <SentAttachments attachments={item.attachments} attachmentUrl={attachmentUrl} />
          ) : null}
          {/* A photo can be the whole message — an empty bubble under it says nothing. */}
          {item.text ? (
            <MessageContent>
              <PromptTokenText text={item.text} />
            </MessageContent>
          ) : null}
        </Message>
      )
    case 'assistant_text':
      return (
        <Message from='assistant'>
          <MessageContent>
            <Response streaming={item.streaming}>{item.text}</Response>
          </MessageContent>
        </Message>
      )
    case 'thinking':
      return <Reasoning isStreaming={item.id === 'streaming-thinking'}>{item.text}</Reasoning>
    case 'tool_call':
      return <ToolCallCard item={item} hostImage={hostImage} />
    case 'turn_result':
      return <TurnResultRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
    case 'file_delivered':
      return <FileCard item={item} href={fileUrl?.(item.path)} />
    default:
      return null
  }
}

/**
 * The "you were here" line: what happened since the session was last looked at,
 * counted from the transcript rather than written by the model (see
 * `summarizeSince`). Everything above it is dimmed while catch-up is on, so the
 * boundary is visible from anywhere in the scrollback, not just at the mark.
 */
function RecapRow({ state, from, since }: { state: TranscriptState; from: number; since?: number }) {
  const lines = useLines()
  const summary = useMemo(() => summarizeSince(state, from), [state, from])
  const line = recapLine(summary)
  if (!line) return null
  const away = since === undefined ? undefined : formatRelativeTime(since)
  const text = away ? `${line} · last here ${away}` : line

  if (lines) {
    return (
      <div data-slot='recap' className='flex items-baseline gap-2 py-0.5'>
        <LineGlyph className='text-accent'>※</LineGlyph>
        <span className='min-w-0 flex-1 text-label leading-5 text-fg-3'>
          <span className='text-fg-2'>recap:</span> {text}
        </span>
      </div>
    )
  }
  return (
    <div data-slot='recap' className='flex items-center gap-2 py-1'>
      <div className='h-px flex-1 bg-border' />
      <span className='font-mono text-label text-fg-3'>※ recap: {text}</span>
      <div className='h-px flex-1 bg-border' />
    </div>
  )
}

/**
 * Has the transcript stopped *filling* and started *streaming*?
 *
 * Attaching replays the whole session as a burst of events, so the content grows
 * by hundreds of rows over a few hundred milliseconds. Animating that — which is
 * the right behaviour for a live turn — turns opening a session into a
 * several-second scroll from its first row to its last, which is precisely wrong
 * when you are skimming sessions to see where each agent got to.
 *
 * So: instant until the arrivals stop for a beat, smooth from then on. Latched,
 * because a live turn is bursty too and nobody wants the follow behaviour to
 * flicker between modes mid-answer.
 */
function useSettled(count: number, quietMs = 250): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled) return
    const timer = setTimeout(() => setSettled(true), quietMs)
    return () => clearTimeout(timer)
  }, [count, settled, quietMs])
  return settled
}

/**
 * When the current run began — the clock the working line counts from.
 *
 * Taken here rather than in the loader because the loader comes and goes within
 * a single turn (it hides the moment text starts streaming), and a clock that
 * restarted every time the model paused for a tool would be measuring the wrong
 * thing. Held as state, not a ref: the value has to survive re-renders and reset
 * exactly once, when the session goes back to idle.
 */
function useRunStart(status: TranscriptState['status']): number | undefined {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

/** Should the "waiting for output" loader show? Only while running with no in-flight
 * streamed content at the tail of the transcript. */
function showLoader(state: TranscriptState): boolean {
  if (state.status !== 'running' && state.status !== 'starting') return false
  const last = state.items.at(-1)
  if (!last) return true
  if (last.kind === 'assistant_text' && last.streaming) return false
  if (last.kind === 'thinking' && last.id === 'streaming-thinking') return false
  return last.kind !== 'turn_result' || state.status === 'running'
}

/** Files sent with a message: thumbnails for images, named chips for the rest.
 * References only — the bytes are fetched from the gateway. */
function SentAttachments({
  attachments,
  attachmentUrl,
}: {
  attachments: MessageAttachment[]
  attachmentUrl?: (attachmentId: string) => string
}) {
  const lines = useLines()
  return (
    <div className={cn('mb-1 flex flex-wrap gap-1.5', lines ? 'justify-start' : 'justify-end')}>
      {attachments.map((attachment) => {
        const href = attachmentUrl?.(attachment.id)
        return attachment.mediaType.startsWith('image/') && href ? (
          <img
            key={attachment.id}
            src={href}
            alt={attachment.name}
            className='size-20 rounded-md border border-border object-cover'
          />
        ) : (
          <span
            key={attachment.id}
            className='rounded-full border border-border bg-surface px-2.5 py-1 text-body-xs text-fg-3'>
            {attachment.name}
          </span>
        )
      })}
    </div>
  )
}

/** Rows produced inside a subagent (`parentToolUseId != null`) are stepped in
 * behind a rule, so a Task's own output reads as belonging to the tool call
 * above it rather than as the main thread carrying on. */
function nestedClass(item: TranscriptItem, lines: boolean): string | undefined {
  const nested = 'parentToolUseId' in item && item.parentToolUseId != null
  if (!nested) return undefined
  return lines ? 'ml-3.5 border-l border-border pl-2' : 'border-l-2 border-border pl-3'
}

export interface TranscriptProps {
  state: TranscriptState
  /** Builds the download URL for a delivered file (see FileCard). Typically
   * `(path) => client.sessionFileUrl(sessionId, path)`. */
  fileUrl?: (path: string) => string
  /** Builds the URL for an uploaded attachment. Typically
   * `(id) => client.attachmentUrl(sessionId, id)`. Same-origin and
   * cookie-authenticated, which is what lets an `<img src>` render one. */
  attachmentUrl?: (attachmentId: string) => string
  /** Whether this gateway serves `@file` search here — the empty state must not
   * advertise an affordance the composer doesn't have. */
  canBrowseFiles?: boolean
  /** Reads a host file as a data URL, for tool calls whose output is a picture
   * on the host (codex's `image_gen`). Omit and those cards name the path. */
  hostImage?: (path: string) => Promise<string | undefined>
  /**
   * How a turn is drawn: `cards` (default, the chat convention) or `lines` —
   * full-width transparent line items with a gutter glyph, for hosts where
   * vertical space is scarce. See {@link TranscriptVariant}.
   */
  variant?: TranscriptVariant
  /**
   * Catch-up: `from` is how many items had been seen last time, `since` when
   * that was. A recap row is drawn at that boundary and everything above it is
   * dimmed. Omit (or pass a boundary at/after the end) and the transcript
   * renders exactly as before.
   */
  catchUp?: { from: number; since?: number }
  className?: string
}

export function Transcript({
  state,
  fileUrl,
  attachmentUrl,
  canBrowseFiles,
  hostImage,
  variant = 'cards',
  catchUp,
  className,
}: TranscriptProps) {
  const lines = variant === 'lines'
  const runStartedAt = useRunStart(state.status)
  const following = useSettled(state.items.length)
  // A boundary at (or past) the end means nothing is new — no row, no dimming.
  const boundary =
    catchUp && catchUp.from > 0 && catchUp.from < state.items.length ? catchUp.from : undefined
  return (
    <TranscriptVariantProvider value={variant}>
      <Conversation className={className} resize={following ? 'smooth' : 'instant'}>
        <ConversationContent className={cn(lines && 'gap-0 px-2 py-1.5')}>
          {state.items.length === 0 && state.status !== 'starting' ? (
            <SessionEmptyState
              cwd={state.cwd}
              hasCommands={!!state.commands?.length}
              hasSkills={!!state.skills?.some((s) => s.enabled)}
              canBrowseFiles={canBrowseFiles}
            />
          ) : (
            state.items.map((item, index) => (
              <Fragment key={`${item.kind}:${item.id}`}>
                {index === boundary ? (
                  <RecapRow state={state} from={boundary} since={catchUp?.since} />
                ) : null}
                <div
                  className={cn(
                    // Full-bleed hover: the row IS the affordance, so the
                    // highlight has to reach past the content gutter.
                    lines && '-mx-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-surface-hover',
                    // Already read: present, legible, and visibly behind you.
                    boundary !== undefined && index < boundary && 'opacity-45',
                    nestedClass(item, lines),
                  )}>
                  <TranscriptItemView
                    item={item}
                    fileUrl={fileUrl}
                    attachmentUrl={attachmentUrl}
                    hostImage={hostImage}
                  />
                </div>
              </Fragment>
            ))
          )}
          {showLoader(state) ? (
            <Loader
              label={state.status === 'starting' ? 'Starting session…' : undefined}
              startedAt={runStartedAt}
              tokens={state.contextUsage?.totalTokens}
              className={cn(lines && 'py-0.5')}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </TranscriptVariantProvider>
  )
}
