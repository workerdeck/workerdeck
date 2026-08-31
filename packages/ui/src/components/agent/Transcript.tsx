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
  if (terminal) {
    return <TerminalItemView item={item} fileUrl={fileUrl} />
  }
  switch (item.kind) {
    case 'user': {
      return (
        <Message from="user">
          {item.attachments?.length ? <SentAttachments attachments={item.attachments} attachmentUrl={attachmentUrl} /> : null}
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

const RecapRow = ({ line, since, terminal }: { line: string; since?: number; terminal?: boolean }) => {
  const away = since === undefined ? undefined : formatRelativeTime(since)
  const text = away ? `${line} · last here ${away}` : line

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

const useRunStart = (status: TranscriptState['status']): number | undefined => {
  const running = status === 'running' || status === 'starting'
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt((previous) => (running ? (previous ?? Date.now()) : undefined))
  }, [running])
  return running ? startedAt : undefined
}

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

const read = (boundary: number | undefined, index: number): boolean => boundary !== undefined && index < boundary

const nestedClass = (item: TranscriptItem, frameParentId?: string): string | undefined => {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  const nested = parent != null && parent !== frameParentId
  return nested ? 'border-l-2 border-border pl-3' : undefined
}

export { rowIndexForItem, type TranscriptRow } from './transcript-rows.ts'

const promptHeadText = (item: Extract<TranscriptItem, { kind: 'user' }>): string =>
  item.text || (item.attachments ?? []).map((attachment) => attachment.name).join(', ')

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
  gapPx: number
  terminal: boolean
  scrollRoot: HTMLElement | null
  index: number
  measureRef: (element: HTMLDivElement | null) => void
  head: ReactNode
  content: ReactNode
}) => {
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
  terminal: boolean
  replaying: boolean
  stickyPrompt: boolean
  gap: { className?: string; px: number }
  fontSize?: number
  lineHeight?: number
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  scrubber?: boolean
  scrubberMarks?: readonly number[]
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
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  canBrowseFiles?: boolean
  hostImage?: (path: string) => Promise<string | undefined>
  variant?: TranscriptVariant
  density?: TranscriptDensity
  fontSize?: number
  lineHeight?: number
  affordances?: TerminalAffordances | boolean
  stickyPrompt?: boolean
  scrubber?: boolean
  scrubberMarks?: readonly number[]
  replaying?: boolean
  catchUp?: { from: number; since?: number }
  jumpToRecapRef?: RefObject<(() => void) | null>
  repinRef?: RefObject<(() => void) | null>
  reveal?: { toolUseId: string; nonce: number }
  frame?: { parentToolUseId: string }
  onOpenSubagent?: (toolUseId: string) => void
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
  const items = useMemo(() => (frame ? subagentItems(state.items, frame.parentToolUseId) : state.items), [state.items, frame])
  const frameTask = useMemo(
    () =>
      frame ? state.items.find((item): item is ToolCallItem => item.kind === 'tool_call' && item.id === frame.parentToolUseId) : undefined,
    [state.items, frame],
  )
  const gap = ROW_GAP[variant][density]
  const runStartedAt = useRunStart(state.status)
  const boundary = !frame && catchUp && catchUp.from > 0 && catchUp.from < state.items.length ? catchUp.from : undefined
  const recap = useMemo(() => (boundary === undefined ? undefined : recapLine(summarizeSince(state, boundary))), [state, boundary])
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
    return [...fold(0, boundary), { key: 'recap' as const, line: recap }, ...fold(boundary, items.length)]
  }, [items, boundary, recap, terminal, brief])
  return (
    <TranscriptVariantProvider value={variant}>
      <Conversation className={cn(replaying && 'invisible', className)}>
        <ConversationContent className={cn(terminal && 'gap-0 p-0')}>
          <TerminalShell active={terminal} fontSize={fontSize} lineHeight={lineHeight} affordances={affordances}>
            {frame ? (
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
