/**
 * **Nothing on this surface animates its scroll position.** VS Code does not —
 * click its editor scrollbar and it jumps — and neither does a terminal, which
 * is the article this transcript is drawing; every travel a reader complained
 * about here was an animation we asked for. Both writers of `scrollTop` (the
 * follow spring, the virtualizer's size-change correction) stay split by
 * regime, and `Conversation` is hardwired to `instant` on `initial` and
 * `resize` — there is no smooth mode left to decide between.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
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
import { ROW_GAP, TranscriptVariantProvider, type TranscriptDensity, type TranscriptVariant } from './transcript-variant.tsx'

const TurnResultRow = ({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) => {
  return (
    <div data-slot="turn-result" className="py-1">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <span className={cn('font-mono text-label', item.isError ? 'text-danger' : 'text-fg-4')}>
          {item.isError ? item.subtype : 'turn done'} · {formatDuration(item.durationMs)} · {formatCost(item.totalCostUsd)}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      {/* A failed turn's reasons are the whole point of the row — dropping them
          leaves "error_during_execution" and nothing to act on. */}
      {item.errors?.length ? (
        <ul className="mt-1 flex flex-col gap-0.5 text-center">
          {item.errors.map((message, index) => (
            <li key={index} className="text-label break-words text-danger">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const NoticeRow = ({ item }: { item: Extract<TranscriptItem, { kind: 'notice' }> }) => {
  return (
    <div
      data-slot="notice"
      className={cn(
        'rounded-md border px-3 py-2 text-body-sm',
        item.level === 'error' ? 'border-transparent bg-danger-bg text-danger' : 'border-border bg-surface text-fg-3',
      )}
    >
      {item.text}
    </div>
  )
}

const TranscriptItemView = ({
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
}) => {
  // The terminal theme is a renderer, not a branch: it draws every kind itself,
  // so the switch below is never reached under it.
  if (terminal) {
    return <TerminalItemView item={item} fileUrl={fileUrl} />
  }
  switch (item.kind) {
    case 'user': {
      return (
        <Message from="user">
          {item.attachments?.length ? <SentAttachments attachments={item.attachments} attachmentUrl={attachmentUrl} /> : null}
          {/* A photo can be the whole message — an empty bubble under it says nothing. */}
          {item.text ? (
            <MessageContent>
              <PromptTokenText text={item.text} />
            </MessageContent>
          ) : null}
        </Message>
      )
    }
    case 'assistant_text': {
      return (
        <Message from="assistant">
          <MessageContent>
            <Response streaming={item.streaming}>{item.text}</Response>
          </MessageContent>
        </Message>
      )
    }
    case 'thinking': {
      return <Reasoning isStreaming={item.id === 'streaming-thinking'}>{item.text}</Reasoning>
    }
    case 'tool_call': {
      return <ToolCallCard item={item} hostImage={hostImage} />
    }
    case 'turn_result': {
      return <TurnResultRow item={item} />
    }
    case 'notice': {
      return <NoticeRow item={item} />
    }
    case 'file_delivered': {
      return <FileCard item={item} href={fileUrl?.(item.path)} />
    }
    default: {
      return null
    }
  }
}

/**
 * The "you were here" line: what happened since the session was last looked at,
 * counted from the transcript (see `summarizeSince`). The line itself is
 * computed in `Transcript`, because a boundary with nothing to say must
 * contribute no row rather than an empty slot that still costs its gap.
 */
const RecapRow = ({ line, since, terminal }: { line: string; since?: number; terminal?: boolean }) => {
  const away = since === undefined ? undefined : formatRelativeTime(since)
  const text = away ? `${line} · last here ${away}` : line

  // Under the terminal theme it must be a `Row` like everything else: the cards
  // markup measures 42px against an 18px line, so it sat off the grid and
  // shifted every row below it by the remainder.
  if (terminal) {
    return (
      <div data-slot="recap">
        <Row glyph="※" glyphTone="faint" tone="faint">
          recap: {text}
        </Row>
      </div>
    )
  }

  return (
    <div data-slot="recap" className="flex items-center gap-2 py-1">
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-label text-fg-3">※ recap: {text}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

/**
 * When the current run began. Taken here rather than in the loader, which comes
 * and goes within a single turn — a clock that restarted every time the model
 * paused for a tool would measure the wrong thing.
 */
const useRunStart = (status: TranscriptState['status']): number | undefined => {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

/** Should the "waiting for output" loader show? Only while running with no in-flight
 * streamed content at the tail of the transcript. */
const showLoader = (state: TranscriptState): boolean => {
  if (state.status !== 'running' && state.status !== 'starting') {
    return false
  }
  const last = state.items.at(-1)
  if (!last) {
    return true
  }
  if (last.kind === 'assistant_text' && last.streaming) {
    return false
  }
  if (last.kind === 'thinking' && last.id === 'streaming-thinking') {
    return false
  }
  return last.kind !== 'turn_result' || state.status === 'running'
}

/** Files sent with a message: thumbnails for images, named chips for the rest.
 * References only — the bytes are fetched from the gateway. */
const SentAttachments = ({
  attachments,
  attachmentUrl,
}: {
  attachments: MessageAttachment[]
  attachmentUrl?: (attachmentId: string) => string
}) => {
  return (
    <div className="mb-1 flex flex-wrap justify-start gap-1.5">
      {attachments.map((attachment) => {
        const href = attachmentUrl?.(attachment.id)
        return attachment.mediaType.startsWith('image/') && href ? (
          <img key={attachment.id} src={href} alt={attachment.name} className="size-20 rounded-md border border-border object-cover" />
        ) : (
          <span key={attachment.id} className="rounded-full border border-border bg-surface px-2.5 py-1 text-body-xs text-fg-3">
            {attachment.name}
          </span>
        )
      })}
    </div>
  )
}

/**
 * The terminal theme's root, and a passthrough otherwise. It must live *inside*
 * the scroller's content element, never around the whole `Conversation`:
 * wrapping the scroller works identically for the inherited cells but breaks
 * the full-bleed bands, whose negative margins are measured against this
 * element's padding.
 */
const TerminalShell = ({
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
}) => {
  if (!active) {
    return <>{children}</>
  }
  return (
    <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={affordances} bleed="1ch" className="term-transcript">
      {children}
    </TerminalSurface>
  )
}

/** Already read: present, legible, and visibly behind you. */
const read = (boundary: number | undefined, index: number): boolean => boundary !== undefined && index < boundary

/** Rows produced inside a subagent (`parentToolUseId != null`) are stepped in
 * behind a rule, so a Task's own output reads as belonging to the tool call
 * above it rather than as the main thread carrying on.
 *
 * **Except inside that sub-agent's own frame**, where those same items are the
 * top level and there is no main thread to be an aside from — stepping every row
 * in would draw a rule down the whole surface saying "this happened somewhere
 * else" about the only thing on screen. */
const nestedClass = (item: TranscriptItem, frameParentId?: string): string | undefined => {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  const nested = parent != null && parent !== frameParentId
  return nested ? 'border-l-2 border-border pl-3' : undefined
}

// The virtual row model — what a row *is*, the spacing rule, and the
// item-index → row-index mapping — lives in `transcript-rows.ts`; re-exported
// here because this file is where consumers have always found them.
export { rowIndexForItem, type TranscriptRow } from './transcript-rows.ts'

/** The cards head's one line: the prompt as plain text, never the `Message`
 * component — a proportional card clipped by height is a sliced bubble.
 * Attachment-only prompts fall back to the attachments' names. */
const promptHeadText = (item: Extract<TranscriptItem, { kind: 'user' }>): string =>
  item.text || (item.attachments ?? []).map((attachment) => attachment.name).join(', ')

/**
 * A prompt row's sticky lane — the strip spanning its turn, leading with the one-line pinned
 * **head**, whose content is the variant's own (terminal re-renders the row and clips it to one
 * line; cards hands theme.css plain text to draw as a compact bar, and only the terminal head
 * carries the row's gap class).
 *
 * The head is `visibility: hidden` until actually stuck — visible in flow it would swallow the
 * real first line's selection highlight — and **stuck is read from a 1px sentinel by a passive
 * scroll listener, never an IntersectionObserver**: IO is edge-triggered, so an instant jump
 * teleports the sentinel across the viewport between two observations and strands the flag. See
 * docs/GOTCHAS.md §Terminal theme and §Web dashboard.
 */
const StickyPromptLane = ({
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
}) => {
  const headRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // `top`/`height`/`gapClass` are deps because they move the sentinel without
  // any scroll; scroll covers the rest, programmatic jumps included.
  useEffect(() => {
    const headElement = headRef.current
    const sentinel = sentinelRef.current
    if (!headElement || !sentinel || !scrollRoot) {
      return
    }
    const evaluate = () => {
      // Strictly above the scrollport's top edge — at exact equality the real
      // row's first line is itself flush with the top, and the head must not
      // cover it.
      const stuck = sentinel.getBoundingClientRect().top < scrollRoot.getBoundingClientRect().top
      headElement.toggleAttribute('data-stuck', stuck)
    }
    evaluate()
    scrollRoot.addEventListener('scroll', evaluate, { passive: true })
    return () => scrollRoot.removeEventListener('scroll', evaluate)
  }, [scrollRoot, top, height, gapClass])
  return (
    // The attribute VALUE is the styling seam: terminal.css matches the bare
    // attribute under `[data-terminal]`, theme.css keys the cards bar on
    // `[data-sticky-lane='cards']`.
    <div data-sticky-lane={terminal ? 'terminal' : 'cards'} className="absolute inset-x-0" style={{ top, height }}>
      {/* The head rides in its own absolutely positioned sub-lane, never in
          flow with a cancelled footprint: sticky confinement clamps the
          *margin* box, so a negative bottom margin lets the head overshoot the
          lane by its own height and puts two pinned prompts on screen at once. */}
      <div data-sticky-headlane="" aria-hidden>
        <div ref={headRef} data-sticky-head="" className={(terminal && gapClass) || undefined}>
          {head}
        </div>
      </div>
      <div
        ref={sentinelRef}
        aria-hidden
        className="absolute left-0 w-px"
        style={{ top: gapClass ? (terminal ? 'var(--term-line)' : gapPx) : 0, height: 1 }}
      />
      <div ref={measureRef} data-index={index} className={gapClass || undefined}>
        {content}
      </div>
    </div>
  )
}

/**
 * The virtualized row window: only rows near the viewport are mounted, so a thousand-row session
 * commits a screenful of DOM rather than all of it.
 *
 * **Two parties want to write `scrollTop`, and they are split by regime**: pinned
 * (`state.isAtBottom`) the virtualizer's size-change corrections are suppressed outright and
 * `use-stick-to-bottom`'s follow spring converges the view; escaped, the virtualizer corrects so
 * the scrollback holds still under the reader. `anchorTo`/`followOnAppend` stay at their defaults
 * so it never becomes a second follow implementation. The accepted costs of virtualizing (
 * find-in-page and select-all reach mounted rows only; a row's transient UI state resets on
 * unmount) and the rest are in docs/GOTCHAS.md §Web dashboard.
 */
const TranscriptRows = ({
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
}) => {
  const stick = useStickToBottomContext()
  // The scroll element belongs to an ancestor, so at mount its ref is not
  // attached yet and a layout effect would see null. A passive effect runs
  // after every ref in the commit is attached, and its re-render is also what
  // lets the virtualizer adopt the element without waiting for a scroll event.
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  // Which rows *could* be the pinned prompt, so the per-scroll work below is a
  // walk over prompts rather than over the transcript.
  const promptRows = useMemo(
    // Top-level prompts only: a subagent's brief is a `user` item too, and an
    // orphan of one must not become the pinned prompt.
    () => rows.flatMap((row, index) => ('item' in row && row.item.kind === 'user' && parentOf(row.item) === undefined ? [index] : [])),
    [rows],
  )
  // The pinned row is forced into the virtual range by `rangeExtractor` below,
  // which reads these refs rather than closing over render values: it runs
  // inside the virtualizer's range pass, where a closure would be stale.
  const pinRef = useRef<{ enabled: boolean; promptRows: readonly number[] }>({
    enabled: false,
    promptRows: [],
  })
  pinRef.current = { enabled: stickyPrompt, promptRows }
  useEffect(() => {
    setScrollElement(stick.scrollRef.current)
  }, [stick.scrollRef])

  // A composer that grows steals a line from the transcript: the two are
  // siblings in the panel's flex column, so typing a newline shrinks this
  // scroller and the row being read slides under the fold.
  // `use-stick-to-bottom` cannot catch it — its ResizeObserver watches the
  // **content** element, and here the content is unchanged and the *scroller*
  // moved, with no scroll event either. Hence an observer of our own.
  //
  // **Re-pin only when already pinned**, or every newline yanks a reader who
  // deliberately scrolled up. Reading `stick.state.isAtBottom` (the live
  // object) is safe for the reason above: no scroll event fired, so the flag
  // still holds the pre-resize answer.
  useEffect(() => {
    if (!scrollElement) {
      return
    }
    let last = scrollElement.clientHeight
    const observer = new ResizeObserver(() => {
      const height = scrollElement.clientHeight
      if (height === last) {
        return
      }
      last = height
      if (stick.state.isAtBottom) {
        void stick.scrollToBottom('instant')
      }
    })
    observer.observe(scrollElement)
    return () => observer.disconnect()
  }, [scrollElement, stick])

  // The replay hold's reveal must paint already at the bottom, and the follow
  // spring cannot: even `scrollToBottom('instant')` defers behind a
  // `requestAnimationFrame`, one frame after the reveal's paint. A layout
  // effect lands in the frame the transcript appears. It presses the library's
  // own `state.scrollTop` setter (recorded in `ignoreScrollToTop`, so the
  // scroll handler knows the write for its own), never a raw `scrollTop`, and
  // only on the hold's falling edge while pinned.
  const wasReplaying = useRef(replaying)
  useLayoutEffect(() => {
    const was = wasReplaying.current
    wasReplaying.current = replaying
    if (!was || replaying) {
      return
    }
    if (!stick.state.isAtBottom) {
      return
    }
    stick.state.scrollTop = stick.state.calculatedTargetScrollTop
  }, [replaying, stick])

  // The height epoch — see `use-height-epoch.ts`. Owned here because this
  // component owns the virtualizer the heights feed.
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const epoch = useHeightEpoch({ terminal, fontSize, lineHeight, rowsRef })

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    // On adopting a scroll element the virtualizer *replays* its remembered
    // offset into the DOM, and by then the pin has usually scrolled the element
    // already — so the remembered 0 yanks a pinned transcript back to the top.
    // Syncing the offset at the adoption boundary makes every replay a no-op.
    // Annotated because the body reads `virtualizer` back: without a declared
    // return type the inference is circular and tsgo gives up on the hook.
    getScrollElement: (): HTMLElement | null => {
      if (scrollElement && virtualizer.scrollElement !== scrollElement) {
        virtualizer.scrollOffset = scrollElement.scrollTop
      }
      return scrollElement
    },
    // Estimates only shape the scrollbar and the span of never-mounted rows; a
    // measurement replaces them the moment a row mounts. Under the terminal
    // theme they are *computed* (`terminal/height.ts`), so the scrollbar is
    // honest before rows mount and `scrollToIndex` sums real sizes instead of
    // accumulating error. The gap rides the same estimate because it is real
    // height on the same measured element. Cards keep the flat constant — they
    // vary too much for any constant to be right, and the calculator has no
    // claim over a proportional face.
    estimateSize: (index) => {
      if (terminal && epoch) {
        const row = rows[index]
        const gapPx = index > 0 && gapBefore(rows, index) ? epoch.line : 0
        // Collapsed by default and clipped to BRIEF_LINES, so its height is
        // known before it mounts. Expanding is local state on a mounted row,
        // which the virtualizer re-measures.
        if (row && 'text' in row && row.key === 'brief') {
          return briefPx(row.text, epoch) + gapPx
        }
        if (row && !('line' in row)) {
          return estimateBlockPx(row, epoch) + gapPx
        }
        return epoch.line + gapPx // recap: one Row, one line
      }
      return (terminal ? 36 : 100) + gap.px
    },
    overscan: 8,
    getItemKey: (index) => rows[index].key,
    // The sticky row, forced into the range, or the pinned prompt's lane
    // unmounts the moment it leaves the window. The active prompt is computed
    // **here**, from the instance's own offset: the range pass runs before the
    // render that would refresh a ref, so a value computed outside this
    // callback is one scroll event stale.
    rangeExtractor: useCallback((range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range))
      const { enabled, promptRows: prompts } = pinRef.current
      if (enabled) {
        const offset = virtualizer.scrollOffset ?? 0
        let pinned = -1
        for (const index of prompts) {
          if ((virtualizer.measurementsCache[index]?.start ?? Infinity) <= offset) {
            pinned = index
          } else {
            break
          }
        }
        if (pinned >= 0) {
          indexes.add(pinned)
        }
      }
      return [...indexes].sort((a, b) => a - b)
    }, []),
    // Explicit and left at the default: it logs a "flushSync was called from
    // inside a lifecycle method" warning, and turning it off costs anchoring —
    // `false` let a scrollback step slide 112px under the reader.
    useFlushSync: true,
    // The list sits below the content div's top padding, so row offsets are a
    // few px shy of true scroll offsets. `scrollMargin` would fix it at the
    // cost of measuring the spacer into state; the error is smaller than one
    // overscan row, so it is deliberately left.
  })
  // Supplying the callback at all replaces the core's default rules, so the
  // escaped branch restates them: on a first measurement compensate any row
  // whose top is above the fold; on a re-measurement only a row *entirely*
  // above it; never while scrolling up, where corrections cascade.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (stick.state.isAtBottom) {
      return false
    }
    const fold = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
    return instance.itemSizeCache.has(item.key) ? item.end <= fold && instance.scrollDirection !== 'backward' : item.start < fold
  }

  // A new epoch invalidates every remembered size, *measurements* included —
  // they were taken at the old width. Feeding the mounted rows straight back in
  // is **not optional**: `measure()` clears the size cache and a row re-enters
  // it only when its ResizeObserver fires, so a row whose height survives the
  // width change would keep its estimate forever and grow a phantom tail.
  useEffect(() => {
    if (!terminal || !epoch) {
      return
    }
    virtualizer.measure()
    const container = rowsRef.current
    if (!container) {
      return
    }
    // Two sharp edges. **Order**: `resizeItem` diffs against
    // `measurementsCache`, which straight after `measure()` is still the
    // pre-wipe array, so an unchanged row diffs to zero and the write is
    // skipped — reading a measurement first rebuilds it from estimates. And
    // **`resizeItem` directly**, never `measureElement`, which is gated on the
    // scroll state and drops measures that land while a scroll is hot.
    virtualizer.getTotalSize()
    for (const element of container.querySelectorAll<HTMLElement>('[data-index]')) {
      const index = Number(element.getAttribute('data-index'))
      if (Number.isInteger(index) && index >= 0) {
        virtualizer.resizeItem(index, element.getBoundingClientRect().height)
      }
    }
  }, [terminal, epoch, virtualizer])

  // The jump machinery lives in `use-transcript-jumps.ts`; every jump on this
  // surface comes through the one function it returns.
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

  // Keyed on the **nonce**, never the id: asking for the same sub-agent twice
  // is a second request, and a props-equal effect would answer only the first.
  // The lookup goes through `rowIndexForItem`, so a Task's id — or a nested
  // child's — resolves to the folded row that absorbed it.
  const revealNonce = reveal?.nonce
  const revealId = reveal?.toolUseId
  useEffect(() => {
    if (revealId === undefined) {
      return
    }
    const itemIndex = items.findIndex((item) => item.kind === 'tool_call' && item.id === revealId)
    // Not here: a compaction, a `/clear`, or a client whose list knows about a
    // Task this transcript has not replayed. Staying put beats jumping.
    if (itemIndex < 0) {
      return
    }
    jumpToRow(rowIndexForItem(rows, itemIndex), 'start')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the nonce IS the trigger
  }, [revealNonce])

  // Interactivity follows the hover affordance: with `affordances={false}` the
  // rail is passive paint and the native scrollbar stays; interactive, the rail
  // IS the scrollbar and the native one is hidden by an attribute.
  const scrubInteractive = resolveAffordances(affordances).hover
  const recapIndex = rows.findIndex((row) => row.key === 'recap')
  const recapRow = recapIndex >= 0 ? { rowIndex: recapIndex, label: (rows[recapIndex] as { line: string }).line } : undefined
  useEffect(() => {
    if (!terminal || !scrubber || !scrubInteractive || !scrollElement) {
      return
    }
    scrollElement.setAttribute('data-term-scrubber-host', '')
    return () => scrollElement.removeAttribute('data-term-scrubber-host')
  }, [terminal, scrubber, scrubInteractive, scrollElement])

  /**
   * The pinned prompt: the prompt's **first line**, held at the top of the scroller by a one-line
   * `overflow: hidden` head that is `aria-hidden` and takes no pointer events. **The pin is the
   * browser's, not ours** — a `position: sticky` head inside an absolutely positioned lane
   * spanning its turn, so the compositor pins and the lane's bottom edge pushes off; a JS-written
   * pin wobbles under momentum scroll. Which row is stuck falls out of the geometry, and the one
   * job left to JS is keeping that row *mounted* — see `rangeExtractor`, and docs/GOTCHAS.md
   * §Terminal theme for the three edges.
   */
  const measurements = virtualizer.measurementsCache

  return (
    <div ref={rowsRef} data-slot="transcript-rows" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        // The inter-row gap folded into each row so the measured height carries
        // it: flex `gap` cannot reach absolutely positioned rows, and a pixel
        // constant would drift from the rem the layout is set in. On the
        // measured wrapper, not the row div, so a nested row's left border
        // still breaks across the gap. Terminal asks whether the pair belongs
        // together; every other variant spaces every row alike.
        const gapClass = virtualRow.index > 0 && (!terminal || gapBefore(rows, virtualRow.index)) ? gap.className : undefined
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
            // No `nestedClass`: the rule belongs *inside* the row, around the
            // children it opens onto — the collapsed line is the main thread's.
            <div className={cn(read(boundary, row.index) && 'opacity-45')}>
              <TaskRow block={row} fileUrl={fileUrl} onOpenSubagent={onOpenSubagent} />
            </div>
          )
        // A prompt row's sticky lane — see the pinned-prompt comment above.
        // The *measured* element is the real row, so the virtualizer's heights
        // are untouched by the head. Only the terminal head carries the row's
        // gap class, because only it is an in-flow overlay of the row.
        // Positioned with `top`, **never the translate every other row gets**:
        // `position: sticky` resolves at layout time and a transform is
        // paint-only, so under a translate the head sticks against the lane's
        // un-translated box and never pins at all. Same predicate as
        // `promptRows` above — the lane and the forced range must agree.
        if (stickyPrompt && 'item' in row && row.item.kind === 'user' && parentOf(row.item) === undefined) {
          const next = promptRows.find((index) => index > virtualRow.index)
          const laneEnd = next === undefined ? virtualizer.getTotalSize() : (measurements[next]?.start ?? virtualRow.start)
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
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {content}
          </div>
        )
      })}
      {/* Portalled beside the scroll element rather than rendered as content:
          it must not scroll with the rows it maps. It lives here because
          everything it draws from is this component's. The target is the
          Conversation root, the containing block the scroll button uses. */}
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
   * Mount the overview scrubber over the scroller's right edge. Two rails
   * behind one prop: under `terminal` a pixel-exact ruler that replaces the
   * native scrollbar, under `cards` a **proportional annotation rail** beside
   * the native scrollbar, which stays. `affordances={false}` degrades either to
   * passive paint.
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
   * render, measure and pin exactly as normal but nothing paints. **Hiding is
   * by `visibility`, never by not mounting.**
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
   * Filled with a closure that scrolls the recap row into view. A ref rather
   * than a DOM query because the rows are virtualized: when the recap row is
   * not mounted, only the virtualizer knows where it would be. `null` while no
   * transcript is mounted.
   */
  jumpToRecapRef?: RefObject<(() => void) | null>
  /**
   * Filled with a closure that re-pins the transcript to the bottom. The panel
   * presses it on send: a transcript left parked where you were reading makes a
   * sent message look like it did nothing.
   */
  repinRef?: RefObject<(() => void) | null>
  /**
   * Scroll a tool call into view — **bump `nonce` to ask again for the same
   * one**, since an identical prop is a no-op. A `parentToolUseId` works as
   * well as the Task's own id: the lookup resolves an absorbed child to the row
   * that folded it. A prop rather than a ref because the asker is outside the
   * webview and the request travels as data.
   */
  reveal?: { toolUseId: string; nonce: number }
  /**
   * Render **only** the work one sub-agent did — the takeover's frame.
   * Membership is `subagentItems` (`terminal/blocks.ts`): everything the agent
   * produced, and not the spawning `Task` call, which *is* the frame.
   *
   * Everything keyed to a **full-transcript item index** is switched off
   * internally while this is set, and the gate lives here rather than at the
   * call site: the catch-up boundary and its recap row, the sticky prompt,
   * `reveal`, and the scrubber's bookmarks. The **scrubber itself stays** — it
   * derives its inputs from the rows it is given, which inside a frame are the
   * sub-agent's own.
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
  const items = useMemo(() => (frame ? subagentItems(state.items, frame.parentToolUseId) : state.items), [state.items, frame])
  // The spawning call, for the header's claim and to tell "not here yet" from
  // "not in this transcript" — see the frame placeholder below.
  const frameTask = useMemo(
    () =>
      frame ? state.items.find((item): item is ToolCallItem => item.kind === 'tool_call' && item.id === frame.parentToolUseId) : undefined,
    [state.items, frame],
  )
  const gap = ROW_GAP[variant][density]
  const runStartedAt = useRunStart(state.status)
  // A boundary at or past the end means nothing is new — no row, no dimming.
  // The "past the end" arm also covers a `/clear`: `conversation_reset` empties
  // `items` while `activityCount` stays monotonic (it is an unread cursor, not
  // an item count), so a session returned to after a clear gets **no recap
  // row** — an index into a conversation that no longer exists cannot say what
  // you missed. Clamping it would read as "nothing is new" instead.
  const boundary = !frame && catchUp && catchUp.from > 0 && catchUp.from < state.items.length ? catchUp.from : undefined
  const recap = useMemo(() => (boundary === undefined ? undefined : recapLine(summarizeSince(state, boundary))), [state, boundary])
  // What this agent was asked, when the stream does not already say: a
  // foreground `Task` forwards its brief as a nested user message, a background
  // agent forwards nothing. Hence the guard rather than an unconditional
  // splice, which would show the instruction twice.
  const brief = useMemo(
    () => (frame && frameTask && !items.some((item) => item.kind === 'user') ? taskBrief(frameTask) : undefined),
    [frame, frameTask, items],
  )
  const rows = useMemo<TranscriptRow[]>(() => {
    const fold = (from: number, to: number) => terminalBlocks(items.slice(from, to), from, terminal)
    const lead: TranscriptRow[] = brief ? [{ key: 'brief' as const, text: brief }] : []
    if (boundary === undefined || !recap) {
      return [...lead, ...fold(0, items.length)]
    }
    // Each side of the boundary folds separately, so a shell run never spans it:
    // "what happened while you were away" must not hide inside a count that also
    // covers what you have already read.
    return [...fold(0, boundary), { key: 'recap' as const, line: recap }, ...fold(boundary, items.length)]
  }, [items, boundary, recap, terminal, brief])
  return (
    <TranscriptVariantProvider value={variant}>
      {/* The replay hold hides by VISIBILITY, never by not mounting: the rows
          must lay out while hidden so the virtualizer measures them, the epoch
          builds and the pin settles, making the reveal one paint of a settled
          tail. `visibility` is also the one hiding property a descendant can
          turn back ON, which is how the loading line stays visible inside a
          hidden root. The root is the right scope because the scrubber and the
          scroll button portal into it, not into the scroller. */}
      <Conversation className={cn(replaying && 'invisible', className)}>
        <ConversationContent className={cn(terminal && 'gap-0 p-0')}>
          <TerminalShell active={terminal} fontSize={fontSize} lineHeight={lineHeight} affordances={affordances}>
            {frame ? (
              // Two different facts: a task present with nothing under it is an
              // agent that has not spoken (the loader says so); a task the
              // transcript does not have is either still replaying or genuinely
              // absent. **Never auto-exit on that** — navigating out from under
              // a reader is worse than one honest line.
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
                /* The rail rides the frame's OWN rows. The **bookmarks do
                 not**: those indices are the host's, in full-transcript space,
                 and painting them here would put marks at meaningless offsets. */
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
                // A *row of the transcript* rather than a spinner over it.
                <>
                  {state.items.length > 0 ? <div className="term-blank" aria-hidden /> : null}
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
        {/* What shows while the hold is on — for a normal attach, *nothing*:
            `wd-hold-appear` (theme.css) fades it in only after 600ms, so a
            healthy hold unmounts it before it paints. An overlay rather than a
            flow row, because the hidden content is at full height and pinned to
            its bottom. It mirrors `ConversationContent`'s wrapper rather than
            the component — a second `StickToBottom.Content` would steal the
            library's content ref. */}
        {replaying ? (
          <div
            data-slot="transcript-hold"
            aria-hidden
            className="wd-hold-appear visible pointer-events-none absolute inset-0 overflow-hidden"
          >
            <div className={cn('mx-auto w-full max-w-[var(--wd-transcript-max-width)]', !terminal && 'px-4 py-4')}>
              {terminal ? (
                <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} affordances={false} bleed="1ch" className="term-transcript">
                  <WorkingRow label="Loading…" />
                </TerminalSurface>
              ) : (
                <Loader label="Loading session…" />
              )}
            </div>
          </div>
        ) : null}
      </Conversation>
    </TranscriptVariantProvider>
  )
}
