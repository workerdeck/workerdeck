import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import {
  approvalCluster,
  buildMarks,
  clusterMarks,
  nearestMember,
  proportionalPlacement,
  type Cluster,
  type Mark,
} from './scrubber-marks.ts'
import { CARD_PEEK, peekContent } from './scrubber-peek.tsx'

export interface ScrubberProps {
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  recapItemIndex?: number
  bookmarks?: readonly number[]
  frameParentId?: string
  interactive?: boolean
  onJumpToItem?: (itemIndex: number) => void
  className?: string
}

export function Scrubber({
  items,
  pendingApprovals,
  recapItemIndex,
  bookmarks,
  frameParentId,
  interactive = false,
  onJumpToItem,
  className,
}: ScrubberProps) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const peekRef = useRef<HTMLDivElement | null>(null)
  const [railH, setRailH] = useState(0)
  const [peek, setPeek] = useState<{ cluster: Cluster; mark: Mark | undefined; y: number } | null>(null)

  useEffect(() => {
    const element = railRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setRailH(element.clientHeight))
    observer.observe(element)
    setRailH(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setPeek(null)
  }, [items])

  useLayoutEffect(() => {
    const element = peekRef.current
    if (!element || !peek) {
      return
    }
    const height = element.offsetHeight
    const railHeight = railRef.current?.clientHeight ?? 0
    element.style.top = `${Math.max(4, Math.min(railHeight - height - 4, peek.y - height / 2))}px`
  }, [peek])

  const clusters = useMemo(() => {
    if (railH <= 0) {
      return []
    }
    const marks = buildMarks(items, { frameParentId, bookmarks, recapItemIndex })
    const built = clusterMarks(marks, proportionalPlacement(railH, items.length))
    if (pendingApprovals.length > 0) {
      built.push(approvalCluster(railH))
    }
    return built
  }, [items, frameParentId, bookmarks, recapItemIndex, pendingApprovals, railH])

  const railY = (clientY: number): number => clientY - (railRef.current?.getBoundingClientRect().top ?? 0)

  const activate = (cluster: Cluster, clientY: number) => {
    if (cluster.kind === 'approval' && cluster.marks.length === 0) {
      if (items.length > 0) {
        onJumpToItem?.(items.length - 1)
      }
      return
    }
    const mark = nearestMember(cluster, railY(clientY))
    if (mark) {
      onJumpToItem?.(mark.itemIndex)
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

  return (
    <div ref={railRef} className={cn('wd-scrubber', className)} data-interactive={interactive || undefined} aria-hidden>
      {clusters.map((cluster, index) => (
        <div
          key={index}
          className="wd-scrub-mark"
          data-lane={cluster.lane}
          data-kind={cluster.kind}
          style={{ top: cluster.y, height: cluster.h }}
          {...(interactive
            ? {
                onClick: (event) => activate(cluster, event.clientY),
                onPointerEnter: (event) => showPeek(cluster, event.clientY),
                onPointerMove: (event) => showPeek(cluster, event.clientY),
                onPointerLeave: () => setPeek(null),
              }
            : null)}
        />
      ))}
      {peek ? (
        <div ref={peekRef} className="wd-scrub-peek" style={{ top: peek.y }}>
          {peekContent({ cluster: peek.cluster, first: peek.mark, items, pendingApprovals }, CARD_PEEK)}
        </div>
      ) : null}
    </div>
  )
}
