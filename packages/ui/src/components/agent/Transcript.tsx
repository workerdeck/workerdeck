import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useStickToBottomContext } from 'use-stick-to-bottom'
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
  ROW_GAP,
  TranscriptVariantProvider,
  useLines,
  type TranscriptDensity,
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
 *
 * The line itself is computed in `Transcript`, not here: the recap is a row of
 * the virtual list, and a boundary with nothing to say must contribute no row
 * at all rather than an empty slot that still costs its gap.
 */
function RecapRow({ line, since }: { line: string; since?: number }) {
  const lines = useLines()
  const away = since === undefined ? undefined : formatRelativeTime(since)
  const text = away ? `${line} · last here ${away}` : line

  if (lines) {
    return (
      <div data-slot='recap' className='flex items-baseline gap-2 py-0.5'>
        <LineGlyph className='text-fg-3'>※</LineGlyph>
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
 *
 * Two guards, both load-bearing, both learned from this going wrong:
 *
 * - **Silence before the first row is not quiet, it is waiting.** The attach
 *   that fills this transcript is a round trip — and in a VS Code webview it is
 *   webview → extension host → gateway and back — so the first replayed row can
 *   land well after the quiet window. A timer started at mount then latches
 *   *before the transcript exists*, and the whole replay animates: exactly the
 *   symptom the latch was added to prevent.
 * - **Only a live turn earns smooth.** An idle session has nothing to animate.
 *   Skimming finished sessions is therefore instant no matter what the timing
 *   did, which is the case that has to be right.
 */
function useSettled(count: number, status: TranscriptState['status'], quietMs = 400): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled || count === 0) return
    const timer = setTimeout(() => setSettled(true), quietMs)
    return () => clearTimeout(timer)
  }, [count, settled, quietMs])
  return settled && (status === 'running' || status === 'starting')
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
  return (
    <div className='mb-1 flex flex-wrap justify-start gap-1.5'>
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

/** One row of the virtual list: a transcript item, or the recap boundary line
 * spliced in at `catchUp.from`. One flat array so the virtualizer sees stable
 * indices, and each row carries the key the item was already React-keyed by —
 * measurements are cached per key, so a row keeps its measured height when the
 * recap splice shifts every index after it. */
type TranscriptRow =
  | { key: string; item: TranscriptItem; index: number }
  | { key: 'recap'; line: string }

/**
 * The virtualized row window. Only rows near the viewport are mounted, so
 * opening a thousand-row session commits a screenful of DOM rather than the
 * whole session in one go.
 *
 * The delicate part is that two parties want to write `scrollTop`.
 * `use-stick-to-bottom` owns *following*: its spring animates toward the
 * bottom whenever the content grows, recomputing the target from the live
 * `scrollHeight` every frame. The virtualizer wants to *correct* `scrollTop`
 * whenever a row measures differently from its estimate, so that what the
 * reader is looking at doesn't shift. Letting both write at once is jitter at
 * best — and a correction that moves the viewport *up* (a row measuring
 * smaller than estimated) reads as a user scroll to the follow logic, which
 * escapes the bottom lock mid-stream.
 *
 * The resolution is that pinned and escaped are different regimes:
 *
 * - Pinned (`state.isAtBottom`), corrections are suppressed. "At the bottom"
 *   is the entire scroll position; the offsets of rows above are moot. The
 *   height change a mismeasured row causes still re-fires the follow spring —
 *   through the same content resize observer that follows streaming — so the
 *   view converges on the bottom through the one writer that knows how to
 *   distinguish its own writes from the user's.
 * - Escaped, the virtualizer corrects (its stock rules, restated below) so
 *   the scrollback holds still under the reader while rows above it measure.
 *
 * `anchorTo`/`followOnAppend` stay at their defaults for the same reason:
 * the virtualizer must never become a second follow implementation.
 *
 * Accepted costs of virtualizing, so they are a decision and not a surprise:
 * browser find-in-page and select-all reach only the mounted rows, and a row's
 * transient UI state (an expanded tool card, an opened reasoning block) resets
 * once the row scrolls far enough away to unmount.
 */
function TranscriptRows({
  rows,
  boundary,
  since,
  lines,
  gap,
  fileUrl,
  attachmentUrl,
  hostImage,
  jumpToRecapRef,
}: {
  rows: TranscriptRow[]
  boundary: number | undefined
  since: number | undefined
  lines: boolean
  /** The inter-row gap for this variant and density (`ROW_GAP`). */
  gap: { className?: string; px: number }
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  hostImage?: (path: string) => Promise<string | undefined>
  jumpToRecapRef?: RefObject<(() => void) | null>
}) {
  const stick = useStickToBottomContext()
  // The scroll element belongs to an ancestor — `StickToBottom.Content`
  // renders it — so when this component's layout effects run at mount, the
  // ancestor's ref is not attached yet and the virtualizer would see null.
  // Handing it over from a passive effect (which runs after every ref in the
  // commit is attached) also guarantees the re-render that lets the
  // virtualizer adopt it promptly: without one, a transcript short enough to
  // never fire a scroll event could sit renderless indefinitely.
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setScrollElement(stick.scrollRef.current)
  }, [stick.scrollRef])
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    // On adopting a scroll element the virtualizer *replays* its remembered
    // offset into the DOM (that is how `initialOffset` is honored). By then
    // the pin has usually scrolled the element already, so the remembered 0
    // would yank a pinned transcript silently back to the top — the observed
    // race was exactly that, the follow jump at ~180ms and the replay undoing
    // it at ~590ms. Syncing the remembered offset to the DOM at the adoption
    // boundary makes every replay a no-op; from then on the scroll observer
    // owns the field.
    // Annotated because the body reads `virtualizer` back: without a declared
    // return type the inference is circular and tsgo gives up on the whole hook.
    getScrollElement: (): HTMLElement | null => {
      if (scrollElement && virtualizer.scrollElement !== scrollElement) {
        virtualizer.scrollOffset = scrollElement.scrollTop
      }
      return scrollElement
    },
    // Estimates only shape the scrollbar and the span of never-mounted rows;
    // a measurement replaces them the moment a row mounts. A lines row is one
    // text line more often than not; cards vary too much for any constant to
    // be right, so that one is merely the order of magnitude.
    // Plus the gap, which is real height on the same measured element — an
    // estimate that ignored it would make the scrollbar visibly too short on a
    // long transcript before the rows mount.
    estimateSize: () => (lines ? 32 : 100) + gap.px,
    overscan: 8,
    getItemKey: (index) => rows[index].key,
    // Explicit, and left at the default, because the obvious cleanup here is
    // wrong. A correction fires from `measureElement`'s ref callback — inside
    // React's commit — so the core's synchronous flush draws a "flushSync was
    // called from inside a lifecycle method" error, which in an embedder's
    // console reads as our bug. Turning it off silences that and costs
    // anchoring: over the same six-step walk up through unmeasured rows, `true`
    // holds the scrollback to the pixel and `false` let one step slide 112px
    // under the reader. Holding still is the entire point of the correction,
    // so the noise stays.
    useFlushSync: true,
    // The list sits below the content div's top padding, so row offsets are a
    // few px shy of true scroll offsets. `scrollMargin` exists for exactly
    // this, but feeding it means measuring the spacer's offsetTop into state;
    // the error is smaller than one overscan row, so it is deliberately left.
  })
  // (See the component comment.) Supplying the callback at all replaces the
  // core's default rules, so the escaped branch restates them: on a first
  // measurement compensate any row whose top sits above the fold; on a
  // re-measurement only a row entirely above it — a row *spanning* the fold
  // grows below the reader's anchor point — and never while scrolling up,
  // where corrections cascade.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (stick.state.isAtBottom) return false
    const fold = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
    return instance.itemSizeCache.has(item.key)
      ? item.end <= fold && instance.scrollDirection !== 'backward'
      : item.start < fold
  }

  // The catch-up strip's "jump" lives outside this scroll container, and the
  // recap row it targets is usually unmounted — only the virtualizer knows
  // where it would be, so the strip is handed this closure instead of a DOM
  // query. Smooth on purpose: the jump IS a journey, and watching it travel
  // is what tells you how far back the boundary was. `stopScroll()` first,
  // because the pin spring is the other `scrollTop` writer and this is the
  // library's own switch for "the user is leaving the bottom".
  //
  // And it has to *re-aim*. Every row between here and the boundary is
  // unmeasured, so the offset the virtualizer scrolls to is the sum of a few
  // hundred estimates; the real one only exists once those rows mount. A
  // single smooth scroll therefore lands a screen or two short — measured at
  // ~3300px off over 600 rows — and it cannot self-correct, because the core
  // suppresses size-change adjustments outright while a smooth scroll is in
  // flight. So: aim, let the rows it crossed measure, aim again from the
  // better estimate. Each pass overshoots by less, and the moment the row is
  // actually mounted the DOM can finish the job exactly.
  //
  // The pending re-aim lives in a ref, and this is the whole reason: the effect
  // that publishes the closure has to re-run every render to keep `rows` fresh,
  // so anything held in its scope is torn down every render too — and a jump in
  // flight re-renders constantly, because that is what rows mounting *is*. A
  // timer in the closure would be cancelled by the very work it is waiting for.
  const aimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(aimTimer.current), [])
  useEffect(() => {
    if (!jumpToRecapRef) return
    jumpToRecapRef.current = () => {
      const index = rows.findIndex((row) => row.key === 'recap')
      if (index < 0) return
      stick.stopScroll()
      clearTimeout(aimTimer.current)
      const aim = (attempt: number) => {
        const row = scrollElement?.querySelector('[data-slot="recap"]')
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        if (attempt >= 6) return
        virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
        // Longer than one frame: the aim is only better once the rows crossed
        // have mounted *and* been measured, and that is a layout pass away.
        aimTimer.current = setTimeout(() => aim(attempt + 1), 300)
      }
      aim(0)
    }
    return () => {
      jumpToRecapRef.current = null
    }
  })

  return (
    <div
      data-slot='transcript-rows'
      className='relative w-full'
      style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className={cn(
              'absolute inset-x-0 top-0',
              // The inter-row gap, folded into each row so the measured height
              // carries it: flex `gap` cannot reach absolutely positioned rows,
              // and a pixel constant for the virtualizer's `gap` option would
              // drift from the rem the layout is set in. On this outer wrapper,
              // not the row div, so a nested row's left border still breaks
              // across the gap as it did under flex. Skipped for the first row —
              // a gap above it would be padding, not spacing.
              virtualRow.index > 0 && gap.className,
            )}
            style={{ transform: `translateY(${virtualRow.start}px)` }}>
            {'item' in row ? (
              <div
                className={cn(
                  // Full-bleed hover: the row IS the affordance, so the
                  // highlight has to reach past the content gutter.
                  lines && '-mx-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-surface-hover',
                  // Already read: present, legible, and visibly behind you.
                  boundary !== undefined && row.index < boundary && 'opacity-45',
                  nestedClass(row.item, lines),
                )}>
                <TranscriptItemView
                  item={row.item}
                  fileUrl={fileUrl}
                  attachmentUrl={attachmentUrl}
                  hostImage={hostImage}
                />
              </div>
            ) : (
              <RecapRow line={row.line} since={since} />
            )}
          </div>
        )
      })}
    </div>
  )
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
   * How much air each row gets: `comfortable` (default — a blank line between
   * messages, as the Claude Code CLI does) or `compact`. Independent of
   * {@link TranscriptVariant}. See {@link TranscriptDensity}.
   */
  density?: TranscriptDensity
  /**
   * Catch-up: `from` is how many items had been seen last time, `since` when
   * that was. A recap row is drawn at that boundary and everything above it is
   * dimmed. Omit (or pass a boundary at/after the end) and the transcript
   * renders exactly as before.
   */
  catchUp?: { from: number; since?: number }
  /**
   * Filled with a closure that scrolls the recap row into view — the seam the
   * panel's catch-up strip presses. A ref rather than a DOM query because the
   * rows are virtualized: when the recap row isn't mounted, only the
   * virtualizer knows where it would be. Optional; embedders without a
   * catch-up strip never touch it. `null` while no transcript is mounted.
   */
  jumpToRecapRef?: RefObject<(() => void) | null>
  className?: string
}

export function Transcript({
  state,
  fileUrl,
  attachmentUrl,
  canBrowseFiles,
  hostImage,
  variant = 'cards',
  density = 'comfortable',
  catchUp,
  jumpToRecapRef,
  className,
}: TranscriptProps) {
  const lines = variant === 'lines'
  const gap = ROW_GAP[variant][density]
  const runStartedAt = useRunStart(state.status)
  const following = useSettled(state.items.length, state.status)
  // A boundary at (or past) the end means nothing is new — no row, no dimming.
  const boundary =
    catchUp && catchUp.from > 0 && catchUp.from < state.items.length ? catchUp.from : undefined
  const recap = useMemo(
    () => (boundary === undefined ? undefined : recapLine(summarizeSince(state, boundary))),
    [state, boundary],
  )
  const rows = useMemo(() => {
    const out: TranscriptRow[] = []
    for (const [index, item] of state.items.entries()) {
      if (index === boundary && recap) out.push({ key: 'recap', line: recap })
      out.push({ key: `${item.kind}:${item.id}`, item, index })
    }
    return out
  }, [state.items, boundary, recap])
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
            <TranscriptRows
              rows={rows}
              boundary={boundary}
              since={catchUp?.since}
              lines={lines}
              gap={gap}
              fileUrl={fileUrl}
              attachmentUrl={attachmentUrl}
              hostImage={hostImage}
              jumpToRecapRef={jumpToRecapRef}
            />
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
