import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { toolInputPreview } from '../../lib/format.ts'
import { cn } from '../../lib/utils.ts'
import {
  approvalCluster,
  buildMarks,
  clusterMarks,
  doneLine,
  excerpt,
  KIND_NAME,
  nearestMember,
  type Cluster,
  type Mark,
} from './scrubber-marks.ts'

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

function peekContent(
  cluster: Cluster,
  first: Mark | undefined,
  items: readonly TranscriptItem[],
  pendingApprovals: readonly PermissionRequest[],
): ReactNode {
  const more = cluster.marks.length > 1 ? ` · ${cluster.marks.length} marks` : ''
  let body: ReactNode = null
  if (cluster.kind === 'approval') {
    const request = pendingApprovals[0]
    body = request ? (
      <>
        <div>{request.title ?? 'Permission required'}</div>
        <div className="wd-scrub-ex" data-tone="muted">
          {`${request.displayName ?? request.toolName}(${toolInputPreview(request.input)})`}
        </div>
      </>
    ) : null
  } else if (first && first.kind !== 'recap') {
    const item = items[first.itemIndex]
    if (first.kind === 'turn' || first.kind === 'turnFailed') {
      const turn = first.turnIndex === undefined ? undefined : items[first.turnIndex]
      body = (
        <>
          {item?.kind === 'assistant_text' ? <div className="wd-scrub-ex">{item.text}</div> : null}
          {turn?.kind === 'turn_result' ? (
            <>
              <div data-tone={turn.isError ? 'danger' : 'muted'}>{doneLine(turn)}</div>
              {turn.errors?.map((message, index) => (
                <div key={index} data-tone="danger">
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
          <div className="wd-scrub-ex" data-tone={first.kind === 'error' || first.kind === 'toolFailed' ? 'danger' : undefined}>
            {first.kind === 'user' ? <span data-tone="muted">{'❯ '}</span> : null}
            {excerpt(item)}
          </div>
          {failure ? (
            <div className="wd-scrub-ex" data-tone="danger">
              {failure}
            </div>
          ) : null}
        </>
      )
    }
  }
  return (
    <>
      <div data-tone="muted">
        {KIND_NAME[first?.kind ?? cluster.kind]}
        {more}
      </div>
      {body}
    </>
  )
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
    const built = clusterMarks(buildMarks(items, { frameParentId, bookmarks, recapItemIndex }), railH, items.length)
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
          {peekContent(peek.cluster, peek.mark, items, pendingApprovals)}
        </div>
      ) : null}
    </div>
  )
}
