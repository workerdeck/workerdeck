import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { MessageAttachment, PermissionRequest } from '@workerdeck/protocol'
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
import { resolveAffordances, type TerminalAffordances } from '../terminal/affordances.tsx'
import {
  ShellRunRow,
  WorkingRow,
  needsBlank,
  terminalBlocks,
  type TerminalBlock,
} from '../terminal/items.tsx'
import {
  createHeightEpoch,
  estimateBlockPx,
  measureCh,
  type HeightEpoch,
} from '../terminal/height.ts'
import { TerminalScrubber } from '../terminal/scrubber.tsx'
import { Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { TerminalItemView } from '../terminal/TerminalTranscript.tsx'
import {
  ROW_GAP,
  TranscriptVariantProvider,
  type TranscriptDensity,
  type TranscriptVariant,
} from './transcript-variant.tsx'

function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
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
  terminal,
}: {
  item: TranscriptItem
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  hostImage?: (path: string) => Promise<string | undefined>
  terminal?: boolean
}) {
  // The terminal theme is a renderer, not a branch: it draws every kind itself,
  // so the switch below is never reached under it.
  if (terminal) return <TerminalItemView item={item} fileUrl={fileUrl} />
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
function RecapRow({ line, since, terminal }: { line: string; since?: number; terminal?: boolean }) {
  const away = since === undefined ? undefined : formatRelativeTime(since)
  const text = away ? `${line} · last here ${away}` : line

  // Under the terminal theme it is a Row like everything else, and that is not
  // cosmetic: the cards markup measures 42px against an 18px line, so it was the
  // one row in the transcript sitting off the grid — and it shifted *every row
  // below it* by the remainder, which is precisely the failure the whole-multiple
  // rule exists to prevent. It was invisible until a fixture carried a recap
  // splice. Being a real row also makes it exactly computable, so the height
  // calculator loses its last estimated constant.
  if (terminal) {
    return (
      <div data-slot='recap'>
        <Row glyph='※' glyphTone='faint' tone='faint'>
          recap: {text}
        </Row>
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

/**
 * The terminal theme's root, when that is the variant, and a passthrough when it
 * is not.
 *
 * It has to live *inside* the scroller's content element rather than around the
 * whole `Conversation`: `--term-line` and `1ch` are inherited, and the rows are
 * rendered by the virtualizer several levels down. Wrapping the scroller instead
 * would work identically for the cells and break the full-bleed bands, whose
 * negative margins are measured against this element's padding.
 */
function TerminalShell({
  active,
  fontSize,
  lineHeight,
  affordances,
  children,
}: {
  active: boolean
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  children: ReactNode
}) {
  if (!active) return <>{children}</>
  return (
    <TerminalSurface
      fontSize={fontSize}
      lineHeight={lineHeight}
      affordances={affordances}
      bleed='1ch'
      className='term-transcript'>
      {children}
    </TerminalSurface>
  )
}

/**
 * Does a blank line go above this row, in the terminal theme?
 *
 * The recap row always earns one — it is a boundary, and a boundary flush
 * against the row above reads as part of it. Otherwise the pair decides
 * (`needsBlank`): consecutive tool calls are one block in the CLI and get none.
 */
function gapBefore(rows: TranscriptRow[], index: number): boolean {
  const before = rowItem(rows[index - 1])
  const after = rowItem(rows[index])
  if (!before || !after) return true
  return needsBlank(before, after)
}

/** Already read: present, legible, and visibly behind you. */
function read(boundary: number | undefined, index: number): boolean {
  return boundary !== undefined && index < boundary
}

/** The item a row is spaced *as*. A shell run stands for the calls it folded,
 * so a run and a lone tool call below it still read as one block. */
function rowItem(row: TranscriptRow | undefined): TranscriptItem | undefined {
  if (!row) return undefined
  if ('item' in row) return row.item
  if ('shell' in row) return row.shell[0]
  return undefined
}

/** Rows produced inside a subagent (`parentToolUseId != null`) are stepped in
 * behind a rule, so a Task's own output reads as belonging to the tool call
 * above it rather than as the main thread carrying on. */
function nestedClass(item: TranscriptItem): string | undefined {
  const nested = 'parentToolUseId' in item && item.parentToolUseId != null
  return nested ? 'border-l-2 border-border pl-3' : undefined
}

/** One row of the virtual list: a {@link TerminalBlock} (a transcript item, or
 * — under the terminal theme — a folded run of shell calls), or the recap
 * boundary line spliced in at `catchUp.from`. One flat array so the virtualizer
 * sees stable indices, and each row carries the key the item was already
 * React-keyed by — measurements are cached per key, so a row keeps its measured
 * height when the recap splice shifts every index after it. */
export type TranscriptRow = TerminalBlock | { key: 'recap'; line: string }

/**
 * Transcript-item index → virtual-row index — **the off-by-a-fold trap.**
 *
 * The virtualizer's rows are {@link TerminalBlock}s, not items: a folded shell
 * run occupies ONE row for `shell.length` consecutive items, and the recap
 * boundary is a row with *no* item index at all, shifting every row after it
 * by one. `virtualizer.scrollToIndex(itemIndex)` is therefore wrong by
 * construction on any folded or spliced transcript — every jump that starts
 * from an item (the scrubber's marks, a future bookmark) must come through
 * here first.
 *
 * The rule: the **last non-recap row whose first item index is ≤ the target**.
 * Rows are ordered by `index` (a shell run's row covers
 * `[index, index + shell.length)`), so this is a binary search; the recap row
 * is skipped by giving it its successor's start for navigation (both qualify
 * at the boundary, and "last wins" lands on the real row) while never letting
 * it be the answer. Exhaustively checked against a linear reference — every
 * fixture × every item index × several splice positions — by
 * `__wdCheckMapping` in `dev/App.tsx`.
 */
export function rowIndexForItem(rows: readonly TranscriptRow[], itemIndex: number): number {
  let lo = 0
  let hi = rows.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const row = rows[mid]!
    let start: number
    if ('index' in row) start = row.index
    else {
      const next = rows[mid + 1]
      start = next && 'index' in next ? next.index : Number.MAX_SAFE_INTEGER
    }
    if (start <= itemIndex) {
      if ('index' in row) best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * A prompt row's sticky lane — the strip spanning its turn, leading with the
 * one-line pinned **head** (see the pinned-prompt comment in
 * {@link TranscriptRows}).
 *
 * The head starts `visibility: hidden` and shows only while actually stuck —
 * an overlay that is visible in flow would sit on the real row's first line
 * and swallow its selection highlight, which reads as "the first line cannot
 * be selected". CSS cannot ask "am I stuck?", so a 1px sentinel at the head's
 * engage threshold (the line's own y) feeds an IntersectionObserver: sentinel
 * above the scrollport top → stuck. Transition-only callbacks — this adds no
 * per-scroll work, and the pin itself is still the compositor's.
 */
function StickyPromptLane({
  top,
  height,
  gapClass,
  scrollRoot,
  index,
  measureRef,
  content,
}: {
  top: number
  height: number
  gapClass?: string | false
  scrollRoot: HTMLElement | null
  index: number
  measureRef: (element: HTMLDivElement | null) => void
  content: ReactNode
}) {
  const headRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const head = headRef.current
    const sentinel = sentinelRef.current
    if (!head || !sentinel || !scrollRoot) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        // Above the scrollport, not merely out of it — a lane still below the
        // viewport has its sentinel non-intersecting too.
        const stuck =
          !entry.isIntersecting &&
          entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)
        head.toggleAttribute('data-stuck', stuck)
      },
      { root: scrollRoot },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [scrollRoot])
  return (
    <div data-sticky-lane='' className='absolute inset-x-0' style={{ top, height }}>
      {/* The head rides in its own absolutely positioned sub-lane rather than
          in flow with a cancelled footprint: sticky confinement clamps the
          *margin* box, and a negative bottom margin shrinks that box to zero
          height — the head then overshoots the lane's end by its own height,
          which put two pinned prompts on screen at once during the handoff.
          Out of flow, the border box is what gets clamped, and the push-off
          lands exactly at the lane's bottom edge. */}
      <div data-sticky-headlane='' aria-hidden>
        <div ref={headRef} data-sticky-head='' className={gapClass || undefined}>
          {content}
        </div>
      </div>
      <div
        ref={sentinelRef}
        aria-hidden
        className='absolute left-0 w-px'
        style={{ top: gapClass ? 'var(--term-line)' : 0, height: 1 }}
      />
      <div ref={measureRef} data-index={index} className={gapClass || undefined}>
        {content}
      </div>
    </div>
  )
}

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
  terminal,
  stickyPrompt,
  gap,
  fontSize,
  lineHeight,
  items,
  pendingApprovals,
  scrubber,
  scrubberMarks,
  affordances,
  fileUrl,
  attachmentUrl,
  hostImage,
  jumpToRecapRef,
}: {
  rows: TranscriptRow[]
  boundary: number | undefined
  since: number | undefined
  /** The terminal theme draws its own rows; see {@link TranscriptItemView}. */
  terminal: boolean
  /** Pin the prompt of the turn being read to the top of the scroller. */
  stickyPrompt: boolean
  /** The inter-row gap for this variant and density (`ROW_GAP`). */
  gap: { className?: string; px: number }
  /** The terminal cell, when the host set one — only read as a signal that the
   * height epoch below must re-measure; the epoch's numbers come from the DOM. */
  fontSize?: number
  lineHeight?: number
  /** The transcript items — the scrubber's marks and peeks render from these,
   * never from the DOM (the row a mark points at is usually unmounted). */
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  /** Mount the overview-ruler rail (terminal theme only). */
  scrubber?: boolean
  scrubberMarks?: readonly number[]
  affordances?: TerminalAffordances | boolean
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
  // Which rows *could* be the pinned prompt. Recomputed only when the row list
  // changes, so the per-scroll work below is a walk over prompts rather than
  // over the transcript.
  const promptRows = useMemo(
    () => rows.flatMap((row, index) => ('item' in row && row.item.kind === 'user' ? [index] : [])),
    [rows],
  )
  // The pinned row must stay mounted even when it is far above the window, so
  // it is forced into the virtual range — see `rangeExtractor` below, which
  // reads these refs rather than closing over render values: it is called from
  // inside the virtualizer's own range pass, where a closure would be a stale
  // render's.
  const pinRef = useRef<{ enabled: boolean; promptRows: readonly number[] }>({
    enabled: false,
    promptRows: [],
  })
  pinRef.current = { enabled: terminal && stickyPrompt, promptRows }
  useEffect(() => {
    setScrollElement(stick.scrollRef.current)
  }, [stick.scrollRef])

  // The height epoch: one cache generation of computed row heights (terminal
  // theme only — cards have no calculator and keep the flat estimate). Owned
  // here because this component owns the virtualizer the heights feed; the
  // WeakMap inside self-invalidates through the reducer's replace-on-mutation,
  // and the epoch itself is replaced wholesale when the wrap width or the cell
  // changes. Measured off the rows container: it *is* the width rows wrap in
  // (the scroller can resize without it moving — `ConversationContent` caps at
  // 48rem — and the window never hears about a splitter drag), and it inherits
  // the surface's font, which is what makes the `ch` probe honest. All DOM
  // reads happen in this effect, debounced; render never touches layout.
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const [epoch, setEpoch] = useState<HeightEpoch | null>(null)
  useEffect(() => {
    if (!terminal) return
    const element = rowsRef.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      const line = Number.parseFloat(
        getComputedStyle(element).getPropertyValue('--term-line'),
      )
      const width = element.clientWidth
      const ch = measureCh(element)
      if (!line || !width || !ch) return
      setEpoch((previous) =>
        previous && previous.width === width && previous.ch === ch && previous.line === line
          ? previous
          : createHeightEpoch(width, ch, line),
      )
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, 150)
    })
    observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
    // fontSize/lineHeight: a cell change re-renders every row, which usually
    // moves the container's size and fires the observer — but a transcript
    // whose height happens to survive the change would keep a stale `ch`, so
    // the props re-arm the measurement directly.
  }, [terminal, fontSize, lineHeight])

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
    // Estimates only shape the scrollbar and the span of never-mounted rows; a
    // measurement replaces them the moment a row mounts. Under the terminal
    // theme they are *computed* (`terminal/height.ts`): the theme's one line
    // height and one cell make a row's height derivable from its item, so the
    // scrollbar is honest before rows mount and `scrollToIndex` sums real
    // sizes instead of accumulating error over unmeasured spans. The gap rides
    // the same estimate because it is real height on the same measured element
    // — one line, decided per pair by `gapBefore`, exactly as the renderer
    // applies the class. The recap row is a Row here too, so it is one line and
    // exact — it used to be the cards markup, which measured 42px against an
    // 18px line and pushed every row below it off the grid.
    // Cards keep the flat constant: they vary too much for any constant to be
    // right, so it is merely the order of magnitude — and the calculator has
    // no claim there (padding scales, borders, a proportional face).
    estimateSize: (index) => {
      if (terminal && epoch) {
        const row = rows[index]
        const gapPx = index > 0 && gapBefore(rows, index) ? epoch.line : 0
        if (row && ('item' in row || 'shell' in row))
          return estimateBlockPx(row, epoch) + gapPx
        return epoch.line + gapPx // recap: one Row, one line
      }
      return (terminal ? 36 : 100) + gap.px
    },
    overscan: 8,
    getItemKey: (index) => rows[index].key,
    // The sticky row, forced into the range. This is the virtualizer's own
    // sticky-header seam: without it the pinned prompt's lane unmounts the
    // moment it leaves the window, which is exactly when it is doing its job.
    // The active prompt — the last one starting at or above the fold — is
    // computed *here*, from the instance's own offset, rather than in the
    // render body: the range pass runs before the render that would refresh a
    // ref, so a value computed outside this callback is one scroll event
    // stale, and a long programmatic jump would leave the pinned row unmounted
    // until the next scroll. (`virtualizer` is safe to close over: the hook
    // returns one stable instance for the component's lifetime.)
    rangeExtractor: useCallback((range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range))
      const { enabled, promptRows: prompts } = pinRef.current
      if (enabled) {
        const offset = virtualizer.scrollOffset ?? 0
        let pinned = -1
        for (const index of prompts) {
          if ((virtualizer.measurementsCache[index]?.start ?? Infinity) <= offset) pinned = index
          else break
        }
        if (pinned >= 0) indexes.add(pinned)
      }
      return [...indexes].sort((a, b) => a - b)
    }, []),
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

  // A new epoch means every remembered size is against the wrong metrics —
  // the *measurements* included, which were taken at the old width. Dropping
  // both together is the whole point: better estimates layered under
  // stale-width measurements would be worse than either alone.
  //
  // The second half is not optional: `measure()` clears the size cache and a
  // row re-enters it only when its ResizeObserver fires — which needs a *size
  // change*. A mounted row whose height happens to survive the width change
  // (short lines that never rewrap) would keep its estimate forever, and
  // wherever the estimate is off the transcript grows a phantom tail — 2,052px
  // of scrollable nothing after one sidebar toggle, on a real session. So the
  // mounted rows are fed straight back in.
  useEffect(() => {
    if (!terminal || !epoch) return
    virtualizer.measure()
    const container = rowsRef.current
    if (!container) return
    // Two sharp edges in the re-feed, both learned the hard way. Order:
    // `resizeItem` diffs a measure against `measurementsCache`, and straight
    // after `measure()` that array is still the pre-wipe one — an unchanged
    // row diffs to zero against its own old measurement and the write is
    // skipped; recomputing first (any measurement read does it) rebuilds the
    // array from estimates, so the diff is real again. And `resizeItem`
    // directly, not `measureElement(element)`: the latter is gated on the
    // scroll state and silently drops a measure that lands while a scroll is
    // still hot — which a resize's own scroll anchoring makes routine.
    virtualizer.getTotalSize()
    for (const element of container.querySelectorAll<HTMLElement>('[data-index]')) {
      const index = Number(element.getAttribute('data-index'))
      if (Number.isInteger(index) && index >= 0)
        virtualizer.resizeItem(index, element.getBoundingClientRect().height)
    }
  }, [terminal, epoch, virtualizer])

  // The jump: aim at a virtual row, land exactly. Every jump on this surface
  // — the catch-up strip's, and each of the scrubber's marks — comes through
  // here. Smooth on purpose: the jump IS a journey, and watching it travel is
  // what tells you how far away the target was. `stopScroll()` first, because
  // the pin spring is the other `scrollTop` writer and this is the library's
  // own switch for "the user is leaving the bottom".
  //
  // The aim loop survives from before the height calculator, with its job
  // changed. It used to be the mechanism: offsets over unmeasured spans were
  // sums of flat estimates (~3300px off over 600 rows), and the loop walked
  // them in up to six passes, each pass better than the last because the rows
  // it crossed had measured. With `estimateSize` computed, the first aim lands
  // within a line or two and the loop is convergence insurance: it absorbs the
  // recap row's estimated constant and flagged content (CJK, compressed
  // tables), and its terminal `scrollIntoView` — possible only once the target
  // is mounted — is what turns "within a line" into "exactly centered".
  //
  // The pending re-aim lives in a ref, and this is the whole reason: the
  // closure is rebuilt every render to keep `rows` fresh, so anything held in
  // its scope is torn down every render too — and a jump in flight re-renders
  // constantly, because that is what rows mounting *is*. A timer in the
  // closure would be cancelled by the very work it is waiting for.
  const aimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(aimTimer.current), [])
  // `align` is the caller's, because the two jumps want different things. A
  // scrubber mark is a place to *start reading* — the answer runs downward from
  // it, so its line lands at exactly the top edge with the screen below it to
  // read into, and centring wastes half the viewport on what you have already
  // read. The recap boundary is the opposite: it is a seam, and seeing a little
  // of what came before is how you place it.
  //
  // The two aligns aim differently, and the split is load-bearing. `'start'`
  // computes the target offset itself — never `scrollIntoView` — because a
  // prompt row is `position: sticky` and scrollIntoView aims at the element's
  // *current* rect, which for a stuck row is wherever it is pinned: the jump
  // would be a no-op on the very rows the scrubber's left lane points at. The
  // target is the row's virtual start plus the rows container's own offset in
  // the scroll content, plus the row's gap padding (the blank line is padding
  // *on* the row, and the reader asked for the line, not its air) — which also
  // lands exactly on the sticky engage threshold, so the row arrives pinned.
  // Re-aims recompute it while rows crossed by the travel measure.
  const jumpToRow = (rowIndex: number, align: 'start' | 'center' = 'center') => {
    if (rowIndex < 0 || rowIndex >= rows.length || !scrollElement) return
    stick.stopScroll()
    clearTimeout(aimTimer.current)
    if (align === 'start') {
      // The gap padding a row's *line* sits below — the target is the line,
      // not its air.
      const linePad = (index: number) =>
        terminal && epoch && index > 0 && gapBefore(rows, index) ? epoch.line : 0
      const target = () => {
        const start = virtualizer.measurementsCache[rowIndex]?.start ?? 0
        const spacer = rowsRef.current
          ? rowsRef.current.getBoundingClientRect().top -
            scrollElement.getBoundingClientRect().top +
            scrollElement.scrollTop
          : 0
        let top = start + spacer + linePad(rowIndex)
        // A non-prompt target lands *below* the pinned prompt, not under it:
        // at this offset the turn's own prompt head is stuck at the top, and a
        // jump that puts the line at zero puts it exactly behind that band —
        // the scrubber's answer marks would all land their first line hidden.
        // The head is one line tall. A jump *to* a prompt keeps zero: it
        // becomes the pinned row itself.
        if (terminal && stickyPrompt && epoch && !promptRows.includes(rowIndex)) {
          const pinned = promptRows.some((index) => index < rowIndex)
          if (pinned) top -= epoch.line
        }
        return Math.round(top)
      }
      const aim = (attempt: number) => {
        const top = target()
        scrollElement.scrollTo({ top, behavior: 'smooth' })
        if (attempt >= 6) return
        aimTimer.current = setTimeout(() => {
          // Off target: still travelling, or a row that measured under the
          // journey moved it. Either way the fix is the same re-aim.
          if (Math.abs(scrollElement.scrollTop - target()) > 1) aim(attempt + 1)
        }, 300)
      }
      aim(0)
      return
    }
    const aim = (attempt: number) => {
      const row = scrollElement.querySelector(`[data-index="${rowIndex}"]`)
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: align })
        return
      }
      if (attempt >= 6) return
      virtualizer.scrollToIndex(rowIndex, { align, behavior: 'smooth' })
      // Longer than one frame: the aim is only better once the rows crossed
      // have mounted *and* been measured, and that is a layout pass away.
      aimTimer.current = setTimeout(() => aim(attempt + 1), 300)
    }
    aim(0)
  }
  useEffect(() => {
    if (!jumpToRecapRef) return
    jumpToRecapRef.current = () => {
      jumpToRow(rows.findIndex((row) => row.key === 'recap'))
    }
    return () => {
      jumpToRecapRef.current = null
    }
  })

  // The scrubber. Interactivity follows the hover affordance — with
  // `affordances={false}` the rail is passive paint (pointer-events off) and
  // the native scrollbar stays; interactive, the rail IS the scrollbar, so the
  // native one is hidden via an attribute on the scroll element.
  const scrubInteractive = resolveAffordances(affordances).hover
  const recapIndex = rows.findIndex((row) => row.key === 'recap')
  const recapRow =
    recapIndex >= 0
      ? { rowIndex: recapIndex, label: (rows[recapIndex] as { line: string }).line }
      : undefined
  useEffect(() => {
    if (!terminal || !scrubber || !scrubInteractive || !scrollElement) return
    scrollElement.setAttribute('data-term-scrubber-host', '')
    return () => scrollElement.removeAttribute('data-term-scrubber-host')
  }, [terminal, scrubber, scrubInteractive, scrollElement])

  /**
   * The pinned prompt: the prompt's **first line**, held at the top of the
   * scroller.
   *
   * One line, not the row: a pasted twenty-line prompt pinned whole covers the
   * viewport and buries the very answer being read under it. So what pins is a
   * **head** — one line tall, `overflow: hidden` — whose content is the same
   * row rendered again, laid exactly over the real row's first line. It is a
   * duplicate, which an earlier design here rejected — but that rejection was
   * of a *separate header* with its own padding and its own idea of the
   * gutter. This copy is the same component in the same column at the same
   * width, so it aligns with the row beneath by construction, and while the
   * row is in flow the overlay is pixel-identical and invisible. It takes no
   * pointer events and is `aria-hidden`: the real row owns interaction and
   * the accessibility tree; the head is paint.
   *
   * The pin itself is the browser's, not ours. Each prompt row renders inside a
   * **lane**: an absolutely positioned strip spanning from the prompt's start to
   * the next prompt's (its turn), with the head `position: sticky` inside it
   * (its flow footprint cancelled by a negative bottom margin, so the real row
   * sits at the lane's top as if the head were not there). The compositor does
   * the pinning and the lane's bottom edge does the push-off — `sticky` is
   * inert on an absolutely positioned element, but works unchanged on a child
   * *of* one, confined to the lane's box. An earlier version clamped the row's
   * transform from render instead, and paid for it every frame: any JS-written
   * pin — React render or a raw scroll handler — runs behind the compositor
   * thread, so the row wobbled under momentum scroll. With the lane there is
   * no per-scroll JS and no lag.
   *
   * Which row — the last prompt at or above the fold, the question the answer
   * on screen belongs to — falls out of the geometry: only the lane spanning
   * the viewport top has its child stuck; every earlier lane has pushed its row
   * off its bottom edge, every later one hasn't reached the top.
   *
   * The one job left to JS is keeping that row *mounted* once it scrolls far
   * above the virtual window — which is exactly when it is working. That lives
   * in the `rangeExtractor` above.
   */
  const measurements = virtualizer.measurementsCache

  return (
    <div
      ref={rowsRef}
      data-slot='transcript-rows'
      className='relative w-full'
      style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        // The inter-row gap, folded into each row so the measured height
        // carries it: flex `gap` cannot reach absolutely positioned rows,
        // and a pixel constant for the virtualizer's `gap` option would
        // drift from the rem the layout is set in. On the measured wrapper,
        // not the row div, so a nested row's left border still breaks
        // across the gap as it did under flex. Skipped for the first row —
        // a gap above it would be padding, not spacing.
        // Every variant but terminal spaces every row alike. Terminal
        // asks whether the pair belongs together — a tool call and its
        // output get no blank line, exactly as the CLI leaves none.
        const gapClass =
          virtualRow.index > 0 && (!terminal || gapBefore(rows, virtualRow.index))
            ? gap.className
            : undefined
        const content =
          'shell' in row ? (
            <div className={cn(read(boundary, row.index) && 'opacity-45')}>
              <ShellRunRow items={row.shell} />
            </div>
          ) : 'item' in row ? (
            <div className={cn(read(boundary, row.index) && 'opacity-45', nestedClass(row.item))}>
              <TranscriptItemView
                item={row.item}
                fileUrl={fileUrl}
                attachmentUrl={attachmentUrl}
                hostImage={hostImage}
                terminal={terminal}
              />
            </div>
          ) : (
            <RecapRow line={row.line} since={since} terminal={terminal} />
          )
        // A prompt row's sticky lane — see the pinned-prompt comment above.
        // The lane is sized to the turn; the sticky **head** (one clipped
        // line, the same content again) comes first with its flow footprint
        // cancelled, and the *measured* element is the real row after it, so
        // the virtualizer's heights are untouched by either. Both carry the
        // gap class: the row because the gap is part of its measured height,
        // the head so its one visible line sits on the same y while in flow —
        // the pin parks that padding above the viewport edge when stuck.
        // Positioned with `top`, NOT the translate every other row gets:
        // `position: sticky` is resolved at layout time and a transform is
        // paint-only, so under a translate the head would stick against the
        // lane's un-translated box at the top of the list — observed as the
        // row clamped to its lane's bottom edge, never pinning at all.
        if (terminal && stickyPrompt && 'item' in row && row.item.kind === 'user') {
          const next = promptRows.find((index) => index > virtualRow.index)
          const laneEnd =
            next === undefined
              ? virtualizer.getTotalSize()
              : (measurements[next]?.start ?? virtualRow.start)
          return (
            <StickyPromptLane
              key={row.key}
              top={virtualRow.start}
              height={Math.max(laneEnd - virtualRow.start, 0)}
              gapClass={gapClass}
              scrollRoot={scrollElement}
              index={virtualRow.index}
              measureRef={virtualizer.measureElement}
              content={content}
            />
          )
        }
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className={cn('absolute inset-x-0 top-0', gapClass)}
            style={{ transform: `translateY(${virtualRow.start}px)` }}>
            {content}
          </div>
        )
      })}
      {/* The overview ruler, portalled beside the scroll element rather than
          rendered as content: it must not scroll with the rows it maps. It
          lives here, not in the shell above, because everything it draws from
          — the virtualizer's offsets, the epoch, the row list, the jump — is
          this component's. The portal target is the Conversation root
          (`relative`), the same containing block the scroll button uses. */}
      {terminal && scrubber && scrollElement?.parentElement
        ? createPortal(
            <TerminalScrubber
              items={items}
              pendingApprovals={pendingApprovals}
              recapRow={recapRow}
              bookmarks={scrubberMarks ?? []}
              rowIndexFor={(itemIndex) => rowIndexForItem(rows, itemIndex)}
              // The public memoized measurements array — `getTotalSize()` just
              // above refreshed it, and with the calculator feeding
              // `estimateSize` these starts are honest for unmounted rows too.
              offsetOfRow={(rowIndex) => virtualizer.measurementsCache[rowIndex]?.start ?? 0}
              sizeOfRow={(rowIndex) => virtualizer.measurementsCache[rowIndex]?.size ?? 0}
              totalSize={virtualizer.getTotalSize()}
              scrollOffset={virtualizer.scrollOffset ?? 0}
              viewportH={virtualizer.scrollRect?.height ?? 0}
              // To the top: a mark is where you start reading, not the middle of
              // what you want to see.
              onJumpToRow={(rowIndex) => jumpToRow(rowIndex, 'start')}
              interactive={scrubInteractive}
              fontSize={fontSize}
              lineHeight={lineHeight}
            />,
            scrollElement.parentElement,
          )
        : null}
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
   * How a turn is drawn: `cards` (default, the chat convention) or `terminal`,
   * which is not a set of branches in these components but its own renderer.
   * See {@link TranscriptVariant}.
   */
  variant?: TranscriptVariant
  /**
   * How much air each row gets: `comfortable` (default — a blank line between
   * messages, as the Claude Code CLI does) or `compact`. Independent of
   * {@link TranscriptVariant}. See {@link TranscriptDensity}.
   */
  density?: TranscriptDensity
  /** Terminal theme only: the character cell, in whole pixels. See
   * {@link TerminalSurface}. */
  fontSize?: number
  lineHeight?: number
  /** Terminal theme only: the pointer affordances a real terminal cannot offer.
   * `false` for none. See {@link TerminalAffordances}. */
  affordances?: TerminalAffordances | boolean
  /** Terminal theme only: hold the prompt of the turn being read at the top of
   * the scroller. The *real* row is pinned, not a copy — see `TranscriptRows`. */
  stickyPrompt?: boolean
  /**
   * Terminal theme only: mount the overview-ruler scrubber — a 2ch rail of
   * marks (your prompts, each turn's response and result as one mark, errors,
   * the pending approval, the catch-up boundary) that replaces the native
   * scrollbar. Ignored under `cards`: the rail's positions ride the height
   * calculator, which has no claim there. With `affordances={false}` the rail
   * degrades to passive paint — no drag, peek or click — and the native
   * scrollbar stays. See {@link TerminalScrubber}.
   */
  scrubber?: boolean
  /**
   * Bookmarked item indices, painted as full-width marks on the rail. Paint
   * only, deliberately: the store — and the affordance that writes it — is
   * the client's, the way the unread watermarks are, not the panel's.
   */
  scrubberMarks?: readonly number[]
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
  fontSize,
  lineHeight,
  affordances,
  stickyPrompt = false,
  scrubber,
  scrubberMarks,
  catchUp,
  jumpToRecapRef,
  className,
}: TranscriptProps) {
  const terminal = variant === 'terminal'
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
  const rows = useMemo<TranscriptRow[]>(() => {
    const fold = (from: number, to: number) =>
      terminalBlocks(state.items.slice(from, to), from, terminal)
    if (boundary === undefined || !recap) return fold(0, state.items.length)
    // Each side of the boundary folds separately, so a shell run never spans it:
    // "what happened while you were away" must not hide inside a count that also
    // covers what you have already read.
    return [
      ...fold(0, boundary),
      { key: 'recap' as const, line: recap },
      ...fold(boundary, state.items.length),
    ]
  }, [state.items, boundary, recap, terminal])
  return (
    <TranscriptVariantProvider value={variant}>
      <Conversation className={className} resize={following ? 'smooth' : 'instant'}>
        <ConversationContent className={cn(terminal && 'gap-0 p-0')}>
          <TerminalShell
            active={terminal}
            fontSize={fontSize}
            lineHeight={lineHeight}
            affordances={affordances}>
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
              terminal={terminal}
              stickyPrompt={stickyPrompt}
              gap={gap}
              fontSize={fontSize}
              lineHeight={lineHeight}
              items={state.items}
              pendingApprovals={state.pendingApprovals}
              scrubber={scrubber}
              scrubberMarks={scrubberMarks}
              affordances={affordances}
              fileUrl={fileUrl}
              attachmentUrl={attachmentUrl}
              hostImage={hostImage}
              jumpToRecapRef={jumpToRecapRef}
            />
          )}
          {showLoader(state) ? (
            terminal ? (
              // The CLI's own working line, and it is a *row of the transcript*
              // rather than a spinner floating over it — one blank line down,
              // like every other block.
              <>
                {state.items.length > 0 ? <div className='term-blank' aria-hidden /> : null}
                <WorkingRow
                  label={state.status === 'starting' ? 'Starting…' : 'Working…'}
                  startedAt={runStartedAt}
                  tokens={state.contextUsage?.totalTokens}
                />
              </>
            ) : (
              <Loader
                label={state.status === 'starting' ? 'Starting session…' : undefined}
                startedAt={runStartedAt}
                tokens={state.contextUsage?.totalTokens}
              />
            )
          ) : null}
          </TerminalShell>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </TranscriptVariantProvider>
  )
}
