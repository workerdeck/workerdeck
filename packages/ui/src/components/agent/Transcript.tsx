import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { ToolRunRow, WorkingRow, parentOf, terminalBlocks } from '../terminal/items.tsx'
import { subagentItems, type ToolCallItem } from '../terminal/blocks.ts'
import { taskBrief } from '../terminal/tool-run.ts'
import { taskBusy } from '../terminal/tool-run.ts'
import { briefPx, estimateBlockPx } from '../terminal/height.ts'
import { TerminalScrubber } from '../terminal/scrubber.tsx'
import { Scrubber } from './Scrubber.tsx'
import { gapBefore, positionInRow, rowIndexForItem, type TranscriptRow } from './transcript-rows.ts'
import { useHeightEpoch } from './use-height-epoch.ts'
import { useTranscriptJumps } from './use-transcript-jumps.ts'
import { Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { BriefRow, TaskRow, TerminalItemView } from '../terminal/TerminalTranscript.tsx'
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
 * **Nothing on this surface animates its scroll position.** VS Code does not —
 * click its editor scrollbar and it jumps — and neither does a terminal, which
 * is the article this transcript is drawing. Every travel a reader ever
 * complained about here was an animation we asked for.
 *
 * What used to be here was `useSettled`: a latch deciding smooth-vs-instant for
 * the follow spring, with a quiet window, a "silence before the first row does
 * not count" guard and a live-status gate — all of it apparatus for a
 * smooth-scroll bug (the attach replays hundreds of rows, and animating that
 * turned opening a session into a several-second journey). With no smooth mode
 * left there is nothing for it to decide, so the whole thing is gone rather
 * than pinned to `false`.
 *
 * The two remaining writers of `scrollTop` — the follow spring and the
 * virtualizer's size-change correction — are unchanged and still split by
 * regime; `Conversation` itself is now hardwired to `instant` on both `initial`
 * and `resize`.
 */

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

/** Already read: present, legible, and visibly behind you. */
function read(boundary: number | undefined, index: number): boolean {
  return boundary !== undefined && index < boundary
}

/** Rows produced inside a subagent (`parentToolUseId != null`) are stepped in
 * behind a rule, so a Task's own output reads as belonging to the tool call
 * above it rather than as the main thread carrying on.
 *
 * **Except inside that sub-agent's own frame**, where those same items are the
 * top level and there is no main thread to be an aside from — stepping every row
 * in would draw a rule down the whole surface saying "this happened somewhere
 * else" about the only thing on screen. */
function nestedClass(item: TranscriptItem, frameParentId?: string): string | undefined {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  const nested = parent != null && parent !== frameParentId
  return nested ? 'border-l-2 border-border pl-3' : undefined
}

// The virtual row model — what a row *is*, the spacing rule, and the
// item-index → row-index mapping — lives in `transcript-rows.ts`; re-exported
// here because this file is where consumers have always found them.
export { rowIndexForItem, type TranscriptRow } from './transcript-rows.ts'

/** The cards head's one line: the prompt as a plain run of text. Deliberately
 * not the Message component — a proportional card clipped by height is a
 * sliced bubble, and un-styling one from CSS is a fight (see theme.css's
 * sticky-prompt block for the other half of this decision). Prompt syntax
 * stays literal — a 28px bar is a reminder of what was asked, not a rendering
 * surface — and newlines collapse under the bar's `nowrap`. Attachment-only
 * prompts fall back to the attachments' names so the bar is never blank. */
function promptHeadText(item: Extract<TranscriptItem, { kind: 'user' }>): string {
  return item.text || (item.attachments ?? []).map((attachment) => attachment.name).join(', ')
}

/**
 * A prompt row's sticky lane — the strip spanning its turn, leading with the
 * one-line pinned **head** (see the pinned-prompt comment in
 * {@link TranscriptRows}).
 *
 * The head's content is the variant's: the terminal passes the row again
 * (clipping it to one line is exact under a monospace grid), cards passes the
 * prompt as plain text for theme.css to draw as a compact bar. Only the
 * terminal head carries the row's gap class — its stuck geometry parks that
 * padding above the viewport edge so the visible line docks at zero
 * (terminal.css); the cards bar never aligns with the row in flow, so the gap
 * stays off it entirely and the 1st prompt and the Nth share one geometry.
 *
 * The head starts `visibility: hidden` and shows only while actually stuck —
 * an overlay that is visible in flow would sit on the real row's first line
 * and swallow its selection highlight, which reads as "the first line cannot
 * be selected". CSS cannot ask "am I stuck?", so a 1px sentinel at the head's
 * engage threshold (the line's own y) answers it: sentinel above the
 * scrollport top → stuck, read by a passive scroll listener. It was an
 * IntersectionObserver once, for the "no per-scroll work" purity — and that
 * was a real bug: IO is edge-triggered, and an *instant* jump (the open-at-
 * bottom pin, `jumpToRow`, a reveal) teleports the sentinel from below the
 * viewport to above it between two observations — ratio 0 → 0, no threshold
 * crossed, `isIntersecting` unchanged — so no entry is ever queued and the
 * flag strands, in whichever direction the jump left it (observed: a session
 * opened at the bottom, its prompt bar missing; the stale-true twin paints a
 * bar over the real bubble). The flag needs level-triggered truth. The cost
 * is two rect reads per scroll event per mounted lane — layout is clean
 * during scrolling, and the pin itself is still the compositor's; only the
 * bar's visibility rides the listener.
 */
function StickyPromptLane({
  top,
  height,
  gapClass,
  gapPx,
  terminal,
  scrollRoot,
  index,
  measureRef,
  head,
  content,
}: {
  top: number
  height: number
  gapClass?: string | false
  /** The gap's size in px (`ROW_GAP[...].px`) — the cards sentinel offset,
   * where the terminal uses `--term-line` (exact against its own cell where a
   * px constant would drift). */
  gapPx: number
  terminal: boolean
  scrollRoot: HTMLElement | null
  index: number
  measureRef: (element: HTMLDivElement | null) => void
  /** What the pinned head shows — see the component comment. */
  head: ReactNode
  content: ReactNode
}) {
  const headRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // `top`/`height`/`gapClass` are deps because they move the sentinel without
  // any scroll: a measurement refinement re-positions the lane under a still
  // scroller, and only a fresh evaluation notices. Scroll covers the rest —
  // including programmatic jumps, which fire a scroll event like any other
  // write of `scrollTop`.
  useEffect(() => {
    const headElement = headRef.current
    const sentinel = sentinelRef.current
    if (!headElement || !sentinel || !scrollRoot) return
    const evaluate = () => {
      // Strictly above the scrollport's top edge — at exact equality the real
      // row's first line is itself flush with the top, and the head must not
      // cover it.
      const stuck =
        sentinel.getBoundingClientRect().top < scrollRoot.getBoundingClientRect().top
      headElement.toggleAttribute('data-stuck', stuck)
    }
    evaluate()
    scrollRoot.addEventListener('scroll', evaluate, { passive: true })
    return () => scrollRoot.removeEventListener('scroll', evaluate)
  }, [scrollRoot, top, height, gapClass])
  return (
    // The attribute VALUE is the styling seam: terminal.css matches the bare
    // attribute under its `[data-terminal]` scope, theme.css keys the cards
    // bar on `[data-sticky-lane='cards']` — no `:not()` acrobatics either side.
    <div
      data-sticky-lane={terminal ? 'terminal' : 'cards'}
      className='absolute inset-x-0'
      style={{ top, height }}>
      {/* The head rides in its own absolutely positioned sub-lane rather than
          in flow with a cancelled footprint: sticky confinement clamps the
          *margin* box, and a negative bottom margin shrinks that box to zero
          height — the head then overshoots the lane's end by its own height,
          which put two pinned prompts on screen at once during the handoff.
          Out of flow, the border box is what gets clamped, and the push-off
          lands exactly at the lane's bottom edge. */}
      <div data-sticky-headlane='' aria-hidden>
        <div ref={headRef} data-sticky-head='' className={(terminal && gapClass) || undefined}>
          {head}
        </div>
      </div>
      <div
        ref={sentinelRef}
        aria-hidden
        className='absolute left-0 w-px'
        style={{ top: gapClass ? (terminal ? 'var(--term-line)' : gapPx) : 0, height: 1 }}
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
  replaying,
  stickyPrompt,
  frameParentId,
  onOpenSubagent,
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
  repinRef,
  reveal,
}: {
  rows: TranscriptRow[]
  boundary: number | undefined
  since: number | undefined
  /** The terminal theme draws its own rows; see {@link TranscriptItemView}. */
  terminal: boolean
  /** The replay hold (see {@link TranscriptProps.replaying}) — read here only
   * for its falling edge, which needs a pre-paint pin. */
  replaying: boolean
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
  /** Set when these rows are a sub-agent's frame — the id everything here was
   *  produced inside. Only `nestedClass` needs it: inside the frame those items
   *  are the top level and must not be stepped in. */
  frameParentId?: string
  onOpenSubagent?: (toolUseId: string) => void
  affordances?: TerminalAffordances | boolean
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  hostImage?: (path: string) => Promise<string | undefined>
  jumpToRecapRef?: RefObject<(() => void) | null>
  repinRef?: RefObject<(() => void) | null>
  reveal?: { toolUseId: string; nonce: number }
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
    // Top-level prompts only: a subagent's brief is a `user` item too, and one
    // that escaped absorption (an orphan) must not become the pinned prompt —
    // it is not what the answer on screen belongs to.
    () =>
      rows.flatMap((row, index) =>
        'item' in row && row.item.kind === 'user' && parentOf(row.item) === undefined
          ? [index]
          : [],
      ),
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
  pinRef.current = { enabled: stickyPrompt, promptRows }
  useEffect(() => {
    setScrollElement(stick.scrollRef.current)
  }, [stick.scrollRef])

  // A composer that grows steals a line from the transcript.
  //
  // The composer and the transcript are siblings in the panel's flex column, so
  // typing a newline shrinks this scroller by one line. "At the bottom" is a
  // `scrollTop`, and that number stops meaning the bottom the moment the
  // viewport changes height — so the last row, the one you were reading, slides
  // under the fold as you type.
  //
  // `use-stick-to-bottom` cannot catch this: its ResizeObserver observes the
  // **content** element (`.observe(content)` in its `useStickToBottom`), and
  // here the content is unchanged and the *scroller* moved. Nor does the browser
  // help — scrollTop is untouched, so no scroll event fires and nothing
  // recomputes. Hence an observer of our own, on the scroller's own box.
  //
  // The guard is the whole feature: re-pin **only when already pinned**, or
  // every newline yanks a reader who had deliberately scrolled up. That state
  // lives in here, which is why this is in `Transcript` and not `SessionPanel`.
  // Reading `stick.state.isAtBottom` (the library's live object, not the
  // rendered boolean) is safe precisely because of the paragraph above: no
  // scroll event fired, so the flag still holds the pre-resize answer.
  //
  // This is not a third writer of `scrollTop` — it presses the follow spring's
  // own button, instantly, which is what the spring would have done had it
  // noticed. The pinned-suppresses-corrections regime below is untouched.
  useEffect(() => {
    if (!scrollElement) return
    let last = scrollElement.clientHeight
    const observer = new ResizeObserver(() => {
      const height = scrollElement.clientHeight
      if (height === last) return
      last = height
      if (stick.state.isAtBottom) void stick.scrollToBottom('instant')
    })
    observer.observe(scrollElement)
    return () => observer.disconnect()
  }, [scrollElement, stick])

  // The replay hold's reveal must paint already at the bottom, and the follow
  // spring cannot make that true: even `scrollToBottom('instant')` defers its
  // write behind a `requestAnimationFrame`, one frame after the reveal's paint
  // — so the first visible frame showed the tail a burst shy of the bottom and
  // then hopped (measured: revealTop 33037 against final 34459 on the 600-row
  // fixture). A layout effect runs after the commit that removed the hold's
  // visibility and before its paint, so this write lands in the very frame the
  // transcript appears. It presses the library's own `state.scrollTop` setter
  // — which records the write in `ignoreScrollToTop`, so the scroll handler
  // knows it for its own — not a raw `scrollTop`, and only on the hold's
  // falling edge, only while pinned; it is the pin's own move made a frame
  // early, not a third writer.
  const wasReplaying = useRef(replaying)
  useLayoutEffect(() => {
    const was = wasReplaying.current
    wasReplaying.current = replaying
    if (!was || replaying) return
    if (!stick.state.isAtBottom) return
    stick.state.scrollTop = stick.state.calculatedTargetScrollTop
  }, [replaying, stick])

  // The height epoch — see `use-height-epoch.ts`. Owned here because this
  // component owns the virtualizer the heights feed.
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const epoch = useHeightEpoch({ terminal, fontSize, lineHeight, rowsRef })

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
        if (row && 'text' in row && row.key === 'brief')
          // Collapsed by default and clipped to BRIEF_LINES, so its height is
          // known before it mounts — the same discipline the task row keeps by
          // always being collapsed when unmounted. Expanding is local state on
          // a mounted row, which the virtualizer re-measures.
          return briefPx(row.text, epoch) + gapPx
        if (row && !('line' in row))
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

  // The jump machinery — the aim loop, the catch-up strip's jump, the re-pin
  // — lives in `use-transcript-jumps.ts`; every jump on this surface comes
  // through the one function it returns.
  const jumpToRow = useTranscriptJumps({
    rows,
    terminal,
    stickyPrompt,
    epoch,
    promptRows,
    scrollElement,
    rowsRef,
    virtualizer,
    stick,
    jumpToRecapRef,
    repinRef,
  })

  // Reveal a tool call from outside the transcript — a sub-agent picked in a
  // sessions list, whose `Task` row is the thing the reader asked for.
  //
  // Keyed on the **nonce**, never on the id: asking for the same sub-agent twice
  // is a second request, and a props-equal effect would answer only the first.
  // The lookup goes through `rowIndexForItem` for the reason that function
  // exists — a row covers a *membership*, not a contiguous span, so a Task's id
  // resolves to the folded row that absorbed it rather than to a position. That
  // also makes a nested child's id work, which is what a client holding only a
  // `parentToolUseId` can offer.
  //
  // `'start'`, like the recap seam and the scrubber's marks: the sub-agent's
  // work runs *downward* from its row, so the reader wants the screen below it.
  const revealNonce = reveal?.nonce
  const revealId = reveal?.toolUseId
  useEffect(() => {
    if (revealId === undefined) return
    const itemIndex = items.findIndex(
      (item) => item.kind === 'tool_call' && item.id === revealId,
    )
    // Not here: a compaction, a `/clear`, or simply a client whose list knows
    // about a Task this transcript has not replayed yet. Staying put beats
    // jumping somewhere arbitrary.
    if (itemIndex < 0) return
    jumpToRow(rowIndexForItem(rows, itemIndex), 'start')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the nonce IS the trigger
  }, [revealNonce])

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
          'run' in row ? (
            <div className={cn(read(boundary, row.index) && 'opacity-45')}>
              <ToolRunRow items={row.run} />
            </div>
          ) : 'item' in row ? (
            <div className={cn(read(boundary, row.index) && 'opacity-45', nestedClass(row.item, frameParentId))}>
              <TranscriptItemView
                item={row.item}
                fileUrl={fileUrl}
                attachmentUrl={attachmentUrl}
                hostImage={hostImage}
                terminal={terminal}
              />
            </div>
          ) : 'text' in row && row.key === 'brief' ? (
            <BriefRow text={row.text} terminal={terminal} />
          ) : 'line' in row ? (
            <RecapRow line={row.line} since={since} terminal={terminal} />
          ) : (
            // A task block. No `nestedClass` here: the rule belongs *inside*
            // the row, around the children it opens onto — the collapsed line
            // is the main thread's, and stepping it in would say a `Task` call
            // happened somewhere else.
            <div className={cn(read(boundary, row.index) && 'opacity-45')}>
              <TaskRow block={row} fileUrl={fileUrl} onOpenSubagent={onOpenSubagent} />
            </div>
          )
        // A prompt row's sticky lane — see the pinned-prompt comment above.
        // The lane is sized to the turn; the sticky **head** comes first, out
        // of flow, and the *measured* element is the real row after it, so
        // the virtualizer's heights are untouched by either. Under terminal
        // the head is the same content again clipped to one line, and carries
        // the row's gap class so its visible line sits on the same y while in
        // flow (the pin parks that padding above the viewport edge when
        // stuck). Under cards the head is the prompt as plain text — theme.css
        // draws it as a compact bar — and carries no gap class: it is never
        // an in-flow overlay of the row, so it has no y to match.
        // Positioned with `top`, NOT the translate every other row gets:
        // `position: sticky` is resolved at layout time and a transform is
        // paint-only, so under a translate the head would stick against the
        // lane's un-translated box at the top of the list — observed as the
        // row clamped to its lane's bottom edge, never pinning at all.
        // Same predicate as `promptRows` above — the lane and the forced range
        // must agree on which rows are prompts.
        if (
          stickyPrompt &&
          'item' in row &&
          row.item.kind === 'user' &&
          parentOf(row.item) === undefined
        ) {
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
              gapPx={gap.px}
              terminal={terminal}
              scrollRoot={scrollElement}
              index={virtualRow.index}
              measureRef={virtualizer.measureElement}
              head={terminal ? content : promptHeadText(row.item)}
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
      {scrubber && scrollElement?.parentElement
        ? createPortal(
            terminal ? (
              <TerminalScrubber
                items={items}
                pendingApprovals={pendingApprovals}
                recapRow={recapRow}
                bookmarks={scrubberMarks ?? []}
                frameParentId={frameParentId}
                rowIndexFor={(itemIndex) => rowIndexForItem(rows, itemIndex)}
                positionInRow={(itemIndex) => positionInRow(rows, itemIndex)}
                offsetOfRow={(rowIndex) => virtualizer.measurementsCache[rowIndex]?.start ?? 0}
                sizeOfRow={(rowIndex) => virtualizer.measurementsCache[rowIndex]?.size ?? 0}
                totalSize={virtualizer.getTotalSize()}
                scrollOffset={virtualizer.scrollOffset ?? 0}
                viewportH={virtualizer.scrollRect?.height ?? 0}
                onJumpToRow={(rowIndex) => jumpToRow(rowIndex, 'start')}
                interactive={scrubInteractive}
                fontSize={fontSize}
                lineHeight={lineHeight}
              />
            ) : (
              <Scrubber
                items={items}
                pendingApprovals={pendingApprovals}
                recapItemIndex={recapIndex >= 0 ? boundary : undefined}
                bookmarks={scrubberMarks}
                frameParentId={frameParentId}
                interactive={scrubInteractive}
                onJumpToItem={(itemIndex) => jumpToRow(rowIndexForItem(rows, itemIndex), 'start')}
              />
            ),
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
  /** Hold the prompt of the turn being read at the top of the scroller. Works
   * in both variants: the terminal clips to one line, cards shows a frosted
   * bar. The *real* row is pinned, not a copy — see `TranscriptRows`. */
  stickyPrompt?: boolean
  /**
   * Mount the overview scrubber — a 12px rail of marks (your prompts, each
   * turn's response and result as one mark, errors, the pending approval, the
   * catch-up boundary) over the scroller's right edge. Two rails behind one
   * prop: under `terminal` it is the pixel-exact ruler that replaces the
   * native scrollbar (positions ride the height calculator; drag scrubs), and
   * under `cards` it is the **proportional annotation rail** — positioned by
   * `itemIndex / items.length`, because proportional text gives the
   * calculator no claim there — where the native scrollbar stays and the rail
   * only peeks and jumps. With `affordances={false}` either rail degrades to
   * passive paint — no drag, peek or click.
   */
  scrubber?: boolean
  /**
   * Bookmarked item indices, painted as full-width marks on the rail. Paint
   * only, deliberately: the store — and the affordance that writes it — is
   * the client's, the way the unread watermarks are, not the panel's.
   */
  scrubberMarks?: readonly number[]
  /**
   * The attach replay is still landing (`useClaudeSession().replaying`): rows
   * render, measure and pin exactly as normal but nothing paints, and a loading
   * line shows in their place; when it flips false the settled tail appears in
   * one frame. Hiding is by *visibility*, never by not mounting — see the
   * comment at the render site. Optional: an embedder that never passes it
   * gets today's behaviour, and a short or empty session holds for no visible
   * time at all (the frame between attach and replay-complete).
   */
  replaying?: boolean
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
  /**
   * Filled with a closure that re-pins the transcript to the bottom, so a host
   * can resume following after the reader has scrolled away. The panel presses
   * it on send: choosing to say something is choosing to watch what happens
   * next, and a transcript left parked where you were reading makes a sent
   * message look like it did nothing at all.
   */
  repinRef?: RefObject<(() => void) | null>
  /**
   * Scroll a tool call into view — bump `nonce` to ask again for the same one.
   *
   * The seam a *list* needs: sub-agent work is nested inside the `Task` call
   * that spawned it, so "open that sub-agent" can only ever mean "take me to its
   * row". A `parentToolUseId` works here as well as the Task's own id, since the
   * lookup resolves an absorbed child to the row that folded it.
   *
   * A prop rather than a ref (the shape `jumpToRecapRef` uses) because the asker
   * is outside this webview entirely and the request travels as data; a ref
   * would need a live closure at the other end of a postMessage bridge.
   */
  reveal?: { toolUseId: string; nonce: number }
  /**
   * Render **only** the work one sub-agent did, rather than the conversation —
   * the sub-agent takeover's frame.
   *
   * Membership is `subagentItems` (`terminal/blocks.ts`), which is also the rule
   * iOS will mirror: everything the agent produced, and not the spawning `Task`
   * call itself, which *is* the frame rather than a row in it.
   *
   * Features are switched off internally whenever it is set, and the gate lives
   * here rather than at the call site on purpose: each is keyed to a
   * **full-transcript item index**, so a host that passed a frame and a catch-up
   * boundary together would not be making a strange choice, it would be making
   * an incoherent one. Those are the catch-up boundary and its recap row, the
   * sticky prompt, `reveal`, and the scrubber's **bookmarks** (host indices in
   * full-transcript space).
   *
   * The **scrubber itself stays**, and the distinction is the point: the rail
   * derives every one of its inputs from the rows it is given, and inside a
   * frame those are the sub-agent's own — so it marks that agent's prompts,
   * answers and failures at that agent's offsets. It was originally gated with
   * the marks, on the reasonable-looking argument that they are one feature;
   * they are two, and a fifty-tool agent run is exactly where a rail earns its
   * keep. What stays besides is everything that makes a long stream readable —
   * virtualization, the height epoch, the follow spring, the replay hold.
   */
  frame?: { parentToolUseId: string }
  /**
   * Raise the takeover from a `Task` row. Absent draws no affordance, which is
   * what the plain renderer and the cards variant get: cards folds nothing, so
   * it has no task blocks to hang this on, and reaches the takeover from the
   * sessions list instead.
   */
  onOpenSubagent?: (toolUseId: string) => void
  /**
   * Replaces the default empty state when the transcript has no items. Pass a
   * `ReactNode` to show your product's own onboarding instead of WorkerDeck's
   * generic "`>_` Tell the agent what to do." placeholder.
   */
  emptyState?: ReactNode
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
  replaying = false,
  catchUp,
  jumpToRecapRef,
  repinRef,
  reveal,
  frame,
  onOpenSubagent,
  emptyState,
  className,
}: TranscriptProps) {
  const terminal = variant === 'terminal'
  // The frame's own item list, and the single place the takeover's content is
  // decided. Everything below reads `items` rather than `state.items`, so the
  // row build, the empty state and the loader all describe the same surface.
  const items = useMemo(
    () => (frame ? subagentItems(state.items, frame.parentToolUseId) : state.items),
    [state.items, frame],
  )
  // The spawning call, for the header's claim and to tell "not here yet" from
  // "not in this transcript" — see the frame placeholder below.
  const frameTask = useMemo(
    () =>
      frame
        ? state.items.find(
            (item): item is ToolCallItem =>
              item.kind === 'tool_call' && item.id === frame.parentToolUseId,
          )
        : undefined,
    [state.items, frame],
  )
  const gap = ROW_GAP[variant][density]
  const runStartedAt = useRunStart(state.status)
  // A boundary at (or past) the end means nothing is new — no row, no dimming.
  //
  // That "past the end" arm now also covers a `/clear`. The mark a client
  // stored is an item index, and `conversation_reset` empties `items` while
  // `activityCount` stays monotonic (it is an unread cursor, not an item count
  // — a count that went backwards would silence the badge for good against a
  // monotonic watermark store). So a session returned to after a clear has a
  // boundary well past its few fresh rows and gets **no recap row**, which is
  // the honest answer: an index into a conversation that no longer exists
  // cannot say what you missed. Clamping it would land on `items.length` and
  // read as "nothing is new" — the same outcome, told less truthfully.
  const boundary =
    !frame && catchUp && catchUp.from > 0 && catchUp.from < state.items.length
      ? catchUp.from
      : undefined
  const recap = useMemo(
    () => (boundary === undefined ? undefined : recapLine(summarizeSince(state, boundary))),
    [state, boundary],
  )
  // What this agent was asked, when the stream does not already say. A
  // foreground `Task` forwards its brief as a real nested user message and it is
  // already the frame's first row; a background agent forwards nothing, and
  // without this the takeover shows an answer with the question missing. Hence
  // the guard rather than an unconditional splice — drawn both ways, the reader
  // would see the same instruction twice.
  const brief = useMemo(
    () =>
      frame && frameTask && !items.some((item) => item.kind === 'user')
        ? taskBrief(frameTask)
        : undefined,
    [frame, frameTask, items],
  )
  const rows = useMemo<TranscriptRow[]>(() => {
    const fold = (from: number, to: number) =>
      terminalBlocks(items.slice(from, to), from, terminal)
    const lead: TranscriptRow[] = brief ? [{ key: 'brief' as const, text: brief }] : []
    if (boundary === undefined || !recap) return [...lead, ...fold(0, items.length)]
    // Each side of the boundary folds separately, so a shell run never spans it:
    // "what happened while you were away" must not hide inside a count that also
    // covers what you have already read.
    return [
      ...fold(0, boundary),
      { key: 'recap' as const, line: recap },
      ...fold(boundary, items.length),
    ]
  }, [items, boundary, recap, terminal, brief])
  return (
    <TranscriptVariantProvider value={variant}>
      {/* The replay hold hides by VISIBILITY, never by not mounting. The rows
          must exist and lay out while hidden: the virtualizer measures them,
          the height epoch builds, and the follow pin settles on the real
          bottom — so the reveal is the removal of one style, a single paint of
          an already-settled tail, and the catch-up jump always fires against a
          measured list. (Unmounting instead would replay the entire
          mount-measure-correct churn, visibly, at reveal time.) `visibility`
          is the one hiding property a descendant can turn back ON, which is
          how the loading line below stays visible inside a hidden root — and
          the root is the right scope because the scrubber and the scroll
          button portal/position into it, not into the scroller. */}
      <Conversation className={cn(replaying && 'invisible', className)}>
        <ConversationContent className={cn(terminal && 'gap-0 p-0')}>
          <TerminalShell
            active={terminal}
            fontSize={fontSize}
            lineHeight={lineHeight}
            affordances={affordances}>
          {frame ? (
            // The frame's own empty states, and they are two different facts.
            // A task that is present with nothing under it yet is simply an
            // agent that has not spoken — the loader below says so. A task the
            // transcript does not have is either still replaying (say nothing,
            // the hold is up) or genuinely absent: a `/clear` retired the
            // conversation it lived in, or the id was never this session's.
            // **Never auto-exit on that** — navigating out from under a reader
            // is worse than one honest line they can leave when they choose.
            frameTask === undefined && !replaying ? (
              <div className={cn(terminal ? 'term-row text-fg-4' : 'p-4 text-body-sm text-fg-4')}>
                This sub-agent's work is not in this transcript.
              </div>
            ) : null
          ) : items.length === 0 && state.status !== 'starting' ? (
            emptyState !== undefined ? (
              emptyState
            ) : (
              <SessionEmptyState
                cwd={state.cwd}
                hasCommands={!!state.commands?.length}
                hasSkills={!!state.skills?.some((s) => s.enabled)}
                canBrowseFiles={canBrowseFiles}
              />
            )
          ) : null}
          {frame && frameTask === undefined && !replaying ? null : (
            <TranscriptRows
              rows={rows}
              boundary={boundary}
              since={catchUp?.since}
              terminal={terminal}
              replaying={replaying}
              stickyPrompt={!frame && stickyPrompt}
              gap={gap}
              fontSize={fontSize}
              lineHeight={lineHeight}
              items={items}
              pendingApprovals={state.pendingApprovals}
              /* The rail rides the frame's OWN rows, so inside a takeover it
                 marks the sub-agent's prompts, answers and failures — the thing
                 a long agent run most needs, and coherent because every input
                 it takes (`items`, `rowIndexFor`, `offsetOfRow`) is the frame's.
                 The **bookmarks are not**: those indices are the host's, in
                 full-transcript space, and painting them here would put marks
                 at meaningless offsets. See `frame`'s doc for the rest. */
              scrubber={scrubber}
              scrubberMarks={frame ? undefined : scrubberMarks}
              affordances={affordances}
              fileUrl={fileUrl}
              attachmentUrl={attachmentUrl}
              hostImage={hostImage}
              jumpToRecapRef={jumpToRecapRef}
              repinRef={repinRef}
              reveal={frame ? undefined : reveal}
              frameParentId={frame?.parentToolUseId}
              onOpenSubagent={frame ? undefined : onOpenSubagent}
            />
          )}
          {(frame ? frameTask !== undefined && taskBusy(frameTask, items) : showLoader(state)) ? (
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
        {/* What shows while the hold is on — and for a normal attach that is
            *nothing*. `wd-hold-appear` (theme.css) keeps it at `opacity: 0`
            and fades it in only after 600ms, so a healthy ~0.5s hold unmounts
            it before it ever paints. An unconditional line here was worse than
            no hold at all: it appeared and vanished inside half a second, which
            is the flicker the hold exists to remove, relocated to the top of
            the panel. Only a genuinely slow attach earns a placeholder, which
            is the case where a reader would otherwise think the panel is dead.
            An overlay rather than a flow row
            because the hidden content is at full height and pinned to its
            bottom; a row in flow would sit at the bottom edge. It mirrors
            `ConversationContent`'s wrapper (not the component itself — a
            second `StickToBottom.Content` would steal the library's content
            ref) so the paddings line up with the real rows'. */}
        {replaying ? (
          <div
            data-slot='transcript-hold'
            aria-hidden
            className='wd-hold-appear visible pointer-events-none absolute inset-0 overflow-hidden'>
            <div
              className={cn(
                'mx-auto w-full max-w-[var(--wd-transcript-max-width)]',
                !terminal && 'px-4 py-4',
              )}>
              {terminal ? (
                <TerminalSurface
                  fontSize={fontSize}
                  lineHeight={lineHeight}
                  affordances={false}
                  bleed='1ch'
                  className='term-transcript'>
                  <WorkingRow label='Loading…' />
                </TerminalSurface>
              ) : (
                <Loader label='Loading session…' />
              )}
            </div>
          </div>
        ) : null}
      </Conversation>
    </TranscriptVariantProvider>
  )
}
