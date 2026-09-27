import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { approvalCluster, buildMarks, clusterMarks, MIN_MARK, nearestMember, type Cluster, type Mark } from '../agent/scrubber-marks.ts'
import { peekContent, TERMINAL_PEEK } from '../agent/scrubber-peek.tsx'
import { TerminalSurface } from './surface.tsx'

export function railScale(railH: number, totalSize: number, viewportH: number): number {
  return totalSize > 0 ? railH / Math.max(totalSize, viewportH) : 0
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
export function buildClusters(props: TerminalScrubberProps, railH: number): Cluster[] {
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
  const marks: Mark[] = buildMarks(items, { frameParentId, bookmarks, rowIndexFor }).map((mark) => ({
    ...mark,
    rowIndex: rowIndexFor(mark.itemIndex),
  }))
  if (recapRow) {
    marks.push({ kind: 'recap', itemIndex: -1, rowIndex: recapRow.rowIndex })
  }
  const scale = railScale(railH, totalSize, viewportH)
  const clusters = clusterMarks(marks, (mark) => {
    const rowIndex = mark.rowIndex ?? rowIndexFor(mark.itemIndex)
    const within = mark.itemIndex >= 0 ? positionInRow?.(mark.itemIndex) : undefined
    const rowH = sizeOfRow(rowIndex)
    const h = within ? MIN_MARK : Math.max(MIN_MARK, Math.round(rowH * scale))
    const offset = offsetOfRow(rowIndex) + (within ? (within.ordinal / within.count) * rowH : 0)
    return { y: Math.min(Math.max(0, railH - h), Math.round(offset * scale)), h }
  })
  if (pendingApprovals.length > 0) {
    clusters.push(approvalCluster(railH))
  }
  return clusters
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

  // Manual listener because it must `preventDefault` - React's root wheel listeners are passive.
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
      onJumpToRow(mark.rowIndex ?? props.rowIndexFor(mark.itemIndex))
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
            {peekContent(
              {
                cluster: peek.cluster,
                first: peek.mark,
                items: props.items,
                pendingApprovals: props.pendingApprovals,
                recapLabel: props.recapRow?.label,
              },
              TERMINAL_PEEK,
            )}
          </div>
        ) : null}
      </div>
    </TerminalSurface>
  )
}
