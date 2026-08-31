import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { parentOf } from './blocks.ts'
import { TerminalSurface } from './surface.tsx'

type Lane = 'l' | 'r' | 'f'
type MarkKind = 'user' | 'subagent' | 'turn' | 'turnFailed' | 'toolFailed' | 'error' | 'approval' | 'recap' | 'bookmark'

type Mark = {
  kind: MarkKind
  itemIndex: number
  rowIndex: number
  turnIndex?: number
}

type Cluster = { lane: Lane; kind: MarkKind; y: number; h: number; marks: { mark: Mark; y: number }[] }

const nearestMember = (cluster: Cluster, y: number): Mark | undefined => {
  let best: { mark: Mark; y: number } | undefined
  for (const member of cluster.marks) {
    if (!best || Math.abs(member.y - y) < Math.abs(best.y - y)) {
      best = member
    }
  }
  return best?.mark
}

const LANE: Record<MarkKind, Lane> = {
  user: 'l',
  subagent: 'l',
  turn: 'r',
  turnFailed: 'r',
  toolFailed: 'r',
  error: 'r',
  approval: 'f',
  recap: 'f',
  bookmark: 'f',
}

const LOUDNESS: Record<MarkKind, number> = {
  approval: 7,
  error: 6,
  turnFailed: 5,
  toolFailed: 4,
  user: 3,
  turn: 2,
  bookmark: 1,
  subagent: 1,
  recap: 0,
}

const KIND_NAME: Record<MarkKind, string> = {
  user: 'you',
  subagent: 'sub-agent',
  turn: 'response · turn end',
  turnFailed: 'turn failed',
  toolFailed: 'tool failed',
  error: 'error',
  approval: 'pending approval',
  recap: 'catch-up boundary',
  bookmark: 'bookmark',
}

const MIN_MARK = 2

export const railScale = (railH: number, totalSize: number, viewportH: number): number => {
  return totalSize > 0 ? railH / Math.max(totalSize, viewportH) : 0
}

type Segment = { response?: number; turn?: number; failed?: boolean }

const doneLine = (turn: Extract<TranscriptItem, { kind: 'turn_result' }>): string =>
  `${turn.isError ? turn.subtype : 'done'} · ${formatDuration(turn.durationMs)} · ${formatCost(turn.totalCostUsd)}`

const excerpt = (item: TranscriptItem): string => {
  switch (item.kind) {
    case 'user':
    case 'assistant_text':
    case 'thinking':
    case 'notice': {
      return item.text
    }
    case 'tool_call': {
      return `${item.name}(${toolInputPreview(item.input)})`
    }
    case 'turn_result': {
      return doneLine(item)
    }
    case 'file_delivered': {
      return item.path
    }
    default: {
      return ''
    }
  }
}

export interface TerminalScrubberProps {
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  recapRow?: { rowIndex: number; label: string }
  bookmarks: readonly number[]
  frameParentId?: string
  rowIndexFor: (itemIndex: number) => number
  offsetOfRow: (rowIndex: number) => number
  sizeOfRow: (rowIndex: number) => number
  positionInRow?: (itemIndex: number) => { ordinal: number; count: number } | undefined
  totalSize: number
  scrollOffset: number
  viewportH: number
  onJumpToRow: (rowIndex: number) => void
  interactive: boolean
  fontSize?: number
  lineHeight?: number
}

// Exported for `test/scrubber.test.ts` only, never from the package.
export const buildClusters = (props: TerminalScrubberProps, railH: number): Cluster[] => {
  const {
    items,
    bookmarks,
    frameParentId,
    recapRow,
    pendingApprovals,
    rowIndexFor,
    offsetOfRow,
    sizeOfRow,
    positionInRow,
    totalSize,
    viewportH,
  } = props
  const marks: Mark[] = []
  const subagentParents = new Set<string>()
  for (const item of items) {
    const parent = parentOf(item)
    if (parent !== undefined) {
      subagentParents.add(parent)
    }
  }
  const rowOutcome = new Map<number, number>()
  items.forEach((item, index) => {
    if (item.kind !== 'tool_call' || parentOf(item) !== frameParentId) {
      return
    }
    rowOutcome.set(rowIndexFor(index), index)
  })
  let segment: Segment = {}
  const closeSegment = () => {
    const anchor = segment.response ?? segment.turn
    if (anchor !== undefined) {
      marks.push({
        kind: segment.failed ? 'turnFailed' : 'turn',
        itemIndex: anchor,
        rowIndex: rowIndexFor(anchor),
        turnIndex: segment.turn,
      })
    }
    segment = {}
  }
  items.forEach((item, index) => {
    if (item.kind === 'tool_call' && subagentParents.has(item.id)) {
      marks.push({ kind: 'subagent', itemIndex: index, rowIndex: rowIndexFor(index) })
    }
    if (item.kind === 'user' && parentOf(item) === frameParentId) {
      closeSegment()
      marks.push({ kind: 'user', itemIndex: index, rowIndex: rowIndexFor(index) })
    } else if (item.kind === 'turn_result') {
      segment.turn = index
      segment.failed = item.isError
      closeSegment()
    } else if (item.kind === 'notice' && item.level === 'error') {
      marks.push({ kind: 'error', itemIndex: index, rowIndex: rowIndexFor(index) })
    } else if (
      item.kind === 'tool_call' &&
      (item.status === 'failed' || item.result?.isError === true) &&
      rowOutcome.get(rowIndexFor(index)) === index
    ) {
      marks.push({ kind: 'toolFailed', itemIndex: index, rowIndex: rowIndexFor(index) })
    } else if (item.kind === 'assistant_text' && parentOf(item) === frameParentId) {
      if (frameParentId !== undefined) {
        marks.push({ kind: 'turn', itemIndex: index, rowIndex: rowIndexFor(index) })
        return
      }
      segment.response = index
    }
  })
  closeSegment()
  for (const index of bookmarks) {
    if (index >= 0 && index < items.length) {
      marks.push({ kind: 'bookmark', itemIndex: index, rowIndex: rowIndexFor(index) })
    }
  }
  if (recapRow) {
    marks.push({ kind: 'recap', itemIndex: -1, rowIndex: recapRow.rowIndex })
  }

  const scale = railScale(railH, totalSize, viewportH)
  const lanes = new Map<Lane, { mark: Mark; y: number; h: number }[]>()
  for (const mark of marks) {
    const within = mark.itemIndex >= 0 ? positionInRow?.(mark.itemIndex) : undefined
    const rowH = sizeOfRow(mark.rowIndex)
    const h = within ? MIN_MARK : Math.max(MIN_MARK, Math.round(rowH * scale))
    const y = Math.min(
      Math.max(0, railH - h),
      Math.round((offsetOfRow(mark.rowIndex) + (within ? (within.ordinal / within.count) * rowH : 0)) * scale),
    )
    const lane = LANE[mark.kind]
    const list = lanes.get(lane) ?? []
    list.push({ mark, y, h })
    lanes.set(lane, list)
  }
  const clusters: Cluster[] = []
  for (const [lane, list] of lanes) {
    list.sort((a, b) => a.y - b.y)
    let current: Cluster | null = null
    for (const { mark, y, h } of list) {
      if (current && y <= current.y + current.h + 1) {
        current.h = Math.max(current.h, y + h - current.y)
        if (LOUDNESS[mark.kind] > LOUDNESS[current.kind]) {
          current.kind = mark.kind
        }
        current.marks.push({ mark, y })
      } else {
        current = { lane, kind: mark.kind, y, h, marks: [{ mark, y }] }
        clusters.push(current)
      }
    }
  }
  if (pendingApprovals.length > 0) {
    clusters.push({
      lane: LANE.approval,
      kind: 'approval',
      y: Math.max(0, railH - MIN_MARK),
      h: MIN_MARK,
      marks: [],
    })
  }
  return clusters
}

const peekContent = (
  cluster: Cluster,
  first: Mark | undefined,
  { items, pendingApprovals, recapRow }: TerminalScrubberProps,
): ReactNode => {
  const more = cluster.marks.length > 1 ? ` · ${cluster.marks.length} marks` : ''
  let body: ReactNode = null
  if (cluster.kind === 'approval') {
    const request = pendingApprovals[0]
    body = request ? (
      <>
        <div data-tone="bright">{request.title ?? 'Permission required'}</div>
        <div className="term-scrub-ex" data-tone="fg">
          {`${request.displayName ?? request.toolName}(${toolInputPreview(request.input)})`}
        </div>
      </>
    ) : null
  } else if (cluster.kind === 'recap' && !first) {
    body = <div data-tone="faint">※ {recapRow?.label}</div>
  } else if (first) {
    const item = items[first.itemIndex]
    if (first.kind === 'recap') {
      body = <div data-tone="faint">※ {recapRow?.label}</div>
    } else if (first.kind === 'turn' || first.kind === 'turnFailed') {
      const turn = first.turnIndex === undefined ? undefined : items[first.turnIndex]
      body = (
        <>
          {item?.kind === 'assistant_text' ? (
            <div className="term-scrub-ex" data-tone="fg">
              <span data-tone="dim">● </span>
              {item.text}
            </div>
          ) : null}
          {turn?.kind === 'turn_result' ? (
            <>
              <div data-tone={turn.isError ? 'red' : 'faint'}>{doneLine(turn)}</div>
              {turn.errors?.map((message, index) => (
                <div key={index} data-tone="red">
                  {message}
                </div>
              ))}
            </>
          ) : null}
        </>
      )
    } else if (item) {
      const failure =
        first.kind === 'toolFailed' && item.kind === 'tool_call'
          ? item.result?.text.split('\n').find((line) => line.trim() !== '')
          : undefined
      body = (
        <>
          <div className="term-scrub-ex" data-tone={first.kind === 'error' || first.kind === 'toolFailed' ? 'red' : 'fg'}>
            {first.kind === 'user' ? <span data-tone="dim">{'❯ '}</span> : null}
            {excerpt(item)}
          </div>
          {failure ? (
            <div className="term-scrub-ex" data-tone="red">
              {failure}
            </div>
          ) : null}
        </>
      )
    }
  }
  return (
    <>
      <div data-tone="faint">
        {KIND_NAME[first?.kind ?? cluster.kind]}
        {more}
      </div>
      {body}
    </>
  )
}

export function TerminalScrubber(props: TerminalScrubberProps) {
  const { scrollOffset, viewportH, totalSize, onJumpToRow, interactive, fontSize, lineHeight } = props
  const stick = useStickToBottomContext()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const peekRef = useRef<HTMLDivElement | null>(null)
  const [railH, setRailH] = useState(0)
  const [peek, setPeek] = useState<{ cluster: Cluster; mark: Mark | undefined; y: number } | null>(null)
  const drag = useRef<{ y: number; moved: boolean; target: EventTarget | null } | null>(null)

  useEffect(() => {
    const element = bodyRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setRailH(element.clientHeight))
    observer.observe(element)
    setRailH(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // The band tracks the scroller's own scroll events, not `scrollOffset`: the virtualizer notifies React only when the row range changes.
  const [liveOffset, setLiveOffset] = useState(scrollOffset)
  useEffect(() => {
    const scroller = stick.scrollRef.current
    if (!scroller) {
      return
    }
    const onScroll = () => setLiveOffset(scroller.scrollTop)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    setLiveOffset(scroller.scrollTop)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [stick.scrollRef])

  useEffect(() => {
    setPeek(null)
  }, [props.items])

  // Manual listener because it must `preventDefault` — React's root wheel listeners are passive.
  useEffect(() => {
    if (!interactive) {
      return
    }
    const element = bodyRef.current
    if (!element) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      const scroller = stick.scrollRef.current
      if (!scroller) {
        return
      }
      scroller.scrollTop += event.deltaY
      event.preventDefault()
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [interactive, stick.scrollRef])

  useLayoutEffect(() => {
    const element = peekRef.current
    if (!element || !peek) {
      return
    }
    const height = element.offsetHeight
    const railHeight = bodyRef.current?.clientHeight ?? 0
    element.style.top = `${Math.max(4, Math.min(railHeight - height - 4, peek.y - height / 2))}px`
  }, [peek])

  // Deps are content and geometry: `rowIndexFor`/`offsetOfRow` are per-render closures, and `totalSize` stands in for their measurements.
  const clusters = useMemo(
    () => (railH > 0 ? buildClusters(props, railH) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.items, props.bookmarks, props.recapRow, props.pendingApprovals, totalSize, railH, viewportH],
  )
  const scale = railScale(railH, totalSize, viewportH)
  const bandH = Math.max(2, Math.min(railH, Math.round(viewportH * scale)))
  const bandTop = Math.max(0, Math.min(railH - bandH, Math.round(liveOffset * scale)))

  const scrub = (clientY: number) => {
    const rail = bodyRef.current
    const scroller = stick.scrollRef.current
    if (!rail || !scroller) {
      return
    }
    const rect = rail.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2
  }

  const railY = (clientY: number): number => clientY - (bodyRef.current?.getBoundingClientRect().top ?? 0)

  const activate = (cluster: Cluster, clientY: number) => {
    if (cluster.kind === 'approval' && cluster.marks.length === 0) {
      void stick.scrollToBottom()
      return
    }
    const mark = nearestMember(cluster, railY(clientY))
    if (mark) {
      onJumpToRow(mark.rowIndex)
    }
  }

  const showPeek = (cluster: Cluster, clientY: number) => {
    const y = railY(clientY)
    const mark = nearestMember(cluster, y)
    setPeek((previous) =>
      previous && previous.cluster === cluster && previous.mark === mark
        ? previous
        : { cluster, mark, y: Math.min(Math.max(y, cluster.y), cluster.y + cluster.h) },
    )
  }

  const maxOffset = Math.max(1, totalSize - viewportH)
  return (
    <TerminalSurface
      fontSize={fontSize}
      lineHeight={lineHeight}
      className="term-scrubber"
      data-interactive={interactive || undefined}
      {...(interactive
        ? {
            role: 'scrollbar',
            'aria-orientation': 'vertical' as const,
            'aria-label': 'Transcript overview',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.min(100, Math.max(0, Math.round((liveOffset / maxOffset) * 100))),
          }
        : { 'aria-hidden': true })}
    >
      <div
        ref={bodyRef}
        className="term-scrubber-body"
        {...(interactive
          ? {
              onPointerDown: (event) => {
                stick.stopScroll()
                drag.current = { y: event.clientY, moved: false, target: event.target }
                event.currentTarget.setPointerCapture(event.pointerId)
              },
              onPointerMove: (event) => {
                const state = drag.current
                if (!state) {
                  return
                }
                if (!state.moved && Math.abs(event.clientY - state.y) < 3) {
                  return
                }
                state.moved = true
                setPeek(null)
                scrub(event.clientY)
              },
              onPointerUp: (event) => {
                const state = drag.current
                drag.current = null
                if (!state || state.moved) {
                  return
                }
                const mark = (state.target as HTMLElement | null)?.closest?.('[data-ci]')
                const index = mark ? Number((mark as HTMLElement).dataset.ci) : Number.NaN
                if (Number.isInteger(index) && clusters[index]) {
                  activate(clusters[index]!, event.clientY)
                } else {
                  scrub(event.clientY)
                }
              },
            }
          : null)}
      >
        <div className="term-scrub-band" style={{ top: bandTop, height: bandH }} />
        {clusters.map((cluster, index) => (
          <div
            key={index}
            data-ci={index}
            className="term-scrub-mark"
            data-lane={cluster.lane}
            data-kind={cluster.kind}
            style={{ top: cluster.y, height: cluster.h }}
            {...(interactive
              ? {
                  onPointerEnter: (event) => showPeek(cluster, event.clientY),
                  onPointerMove: (event) => {
                    if (!drag.current) {
                      showPeek(cluster, event.clientY)
                    }
                  },
                  onPointerLeave: () => setPeek(null),
                }
              : null)}
          />
        ))}
        {peek ? (
          <div ref={peekRef} className="term-scrub-peek" style={{ top: peek.y }}>
            {peekContent(peek.cluster, peek.mark, props)}
          </div>
        ) : null}
      </div>
    </TerminalSurface>
  )
}
