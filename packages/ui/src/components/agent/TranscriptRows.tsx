import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { resolveAffordances, type TerminalAffordances } from '../terminal/affordances.tsx'
import { ToolRunRow } from '../terminal/items.tsx'
import { parentOf } from '../terminal/blocks.ts'
import { briefPx, estimateBlockPx } from '../terminal/height.ts'
import { TerminalScrubber } from '../terminal/scrubber.tsx'
import { Scrubber } from './Scrubber.tsx'
import { gapBefore, positionInRow, rowIndexForItem, type TranscriptRow } from './transcript-rows.ts'
import { useHeightEpoch } from './use-height-epoch.ts'
import { useTranscriptJumps } from './use-transcript-jumps.ts'
import { BriefRow, TaskRow } from '../terminal/TerminalTranscript.tsx'
import { RecapRow, TranscriptItemView } from './TranscriptItemView.tsx'

function read(boundary: number | undefined, index: number): boolean {
  return boundary !== undefined && index < boundary
}

function nestedClass(item: TranscriptItem, frameParentId?: string): string | undefined {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  const nested = parent != null && parent !== frameParentId
  return nested ? 'border-l-2 border-border pl-3' : undefined
}

function promptHeadText(item: Extract<TranscriptItem, { kind: 'user' }>): string {
  return item.text || (item.attachments ?? []).map((attachment) => attachment.name).join(', ')
}

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
  gapPx: number
  terminal: boolean
  scrollRoot: HTMLElement | null
  index: number
  measureRef: (element: HTMLDivElement | null) => void
  head: ReactNode
  content: ReactNode
}) {
  const headRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const headElement = headRef.current
    const sentinel = sentinelRef.current
    if (!headElement || !sentinel || !scrollRoot) {
      return
    }
    const evaluate = () => {
      const stuck = sentinel.getBoundingClientRect().top < scrollRoot.getBoundingClientRect().top
      headElement.toggleAttribute('data-stuck', stuck)
    }
    evaluate()
    scrollRoot.addEventListener('scroll', evaluate, { passive: true })
    return () => scrollRoot.removeEventListener('scroll', evaluate)
  }, [scrollRoot, top, height, gapClass])
  return (
    <div data-sticky-lane={terminal ? 'terminal' : 'cards'} className="absolute inset-x-0" style={{ top, height }}>
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

// The virtualized row lane and its scroll-ownership regime. Two things want to write
// `scrollTop` — the follow spring and the virtualizer's size-change corrections — and they are
// split by regime here: pinned, corrections are suppressed outright; escaped, the virtualizer
// corrects so the scrollback holds still (GOTCHAS "The transcript is virtualized").
export function TranscriptRows({
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
  bookmarks,
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
  terminal: boolean
  replaying: boolean
  stickyPrompt: boolean
  gap: { className?: string; px: number }
  fontSize?: number
  lineHeight?: number
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  scrubber?: boolean
  bookmarks?: readonly string[]
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
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const promptRows = useMemo(
    () => rows.flatMap((row, index) => ('item' in row && row.item.kind === 'user' && parentOf(row.item) === undefined ? [index] : [])),
    [rows],
  )
  const pinRef = useRef<{ enabled: boolean; promptRows: readonly number[] }>({
    enabled: false,
    promptRows: [],
  })
  pinRef.current = { enabled: stickyPrompt, promptRows }
  useEffect(() => {
    // A passive effect, not a layout one: the scroll element belongs to an ancestor, so at mount its ref is not attached yet and a layout effect reads null.
    setScrollElement(stick.scrollRef.current)
  }, [stick.scrollRef])

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

  const rowsRef = useRef<HTMLDivElement | null>(null)
  const epoch = useHeightEpoch({ terminal, fontSize, lineHeight, rowsRef })

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    // The return type is annotated because the body reads `virtualizer` back: without it the inference is circular and tsgo gives up on the hook.
    getScrollElement: (): HTMLElement | null => {
      if (scrollElement && virtualizer.scrollElement !== scrollElement) {
        // On adopting a scroll element the virtualizer replays its remembered offset into the DOM, so syncing here keeps a remembered 0 from yanking a pinned transcript to the top.
        virtualizer.scrollOffset = scrollElement.scrollTop
      }
      return scrollElement
    },
    estimateSize: (index) => {
      if (terminal && epoch) {
        const row = rows[index]
        const gapPx = index > 0 && gapBefore(rows, index) ? epoch.line : 0
        if (row && 'text' in row && row.key === 'brief') {
          return briefPx(row.text, epoch) + gapPx
        }
        if (row && !('line' in row)) {
          return estimateBlockPx(row, epoch) + gapPx
        }
        return epoch.line + gapPx
      }
      return (terminal ? 36 : 100) + gap.px
    },
    overscan: 8,
    getItemKey: (index) => rows[index].key,
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
    useFlushSync: true,
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (stick.state.isAtBottom) {
      return false
    }
    const fold = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
    return instance.itemSizeCache.has(item.key) ? item.end <= fold && instance.scrollDirection !== 'backward' : item.start < fold
  }

  useEffect(() => {
    if (!terminal || !epoch) {
      return
    }
    virtualizer.measure()
    const container = rowsRef.current
    if (!container) {
      return
    }
    virtualizer.getTotalSize()
    for (const element of container.querySelectorAll<HTMLElement>('[data-index]')) {
      const index = Number(element.getAttribute('data-index'))
      if (Number.isInteger(index) && index >= 0) {
        virtualizer.resizeItem(index, element.getBoundingClientRect().height)
      }
    }
  }, [terminal, epoch, virtualizer])

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

  const revealNonce = reveal?.nonce
  const revealId = reveal?.toolUseId
  useEffect(() => {
    if (revealId === undefined) {
      return
    }
    const itemIndex = items.findIndex((item) => item.kind === 'tool_call' && item.id === revealId)
    if (itemIndex < 0) {
      return
    }
    jumpToRow(rowIndexForItem(rows, itemIndex), 'start')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the nonce IS the trigger
  }, [revealNonce])

  const scrubInteractive = resolveAffordances(affordances).hover
  // Hosts hand bookmarks over as item ids (stable across replays); the mark model positions by
  // index, so the translation lives here where the items are. Ids not in this transcript (another
  // frame, a truncated replay) simply draw nothing.
  const bookmarkIndexes = useMemo(() => {
    if (!bookmarks?.length) {
      return []
    }
    const indexById = new Map(items.map((item, index) => [item.id, index]))
    return bookmarks.map((id) => indexById.get(id)).filter((index): index is number => index !== undefined)
  }, [bookmarks, items])
  const recapIndex = rows.findIndex((row) => row.key === 'recap')
  const recapRow = recapIndex >= 0 ? { rowIndex: recapIndex, label: (rows[recapIndex] as { line: string }).line } : undefined
  useEffect(() => {
    if (!terminal || !scrubber || !scrubInteractive || !scrollElement) {
      return
    }
    scrollElement.setAttribute('data-term-scrubber-host', '')
    return () => scrollElement.removeAttribute('data-term-scrubber-host')
  }, [terminal, scrubber, scrubInteractive, scrollElement])

  const measurements = virtualizer.measurementsCache

  return (
    <div ref={rowsRef} data-slot="transcript-rows" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
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
            <div className={cn(read(boundary, row.index) && 'opacity-45')}>
              <TaskRow block={row} fileUrl={fileUrl} onOpenSubagent={onOpenSubagent} />
            </div>
          )
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
      {scrubber && scrollElement?.parentElement
        ? createPortal(
            terminal ? (
              <TerminalScrubber
                items={items}
                pendingApprovals={pendingApprovals}
                recapRow={recapRow}
                bookmarks={bookmarkIndexes}
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
                bookmarks={bookmarkIndexes}
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
