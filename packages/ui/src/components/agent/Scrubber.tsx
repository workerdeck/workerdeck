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

/**
 * The cards variant's overview rail.
 *
 * Positions are **index space**: mark y is `itemIndex / items.length` of the
 * rail, because proportional text and variable row heights leave the cards
 * transcript with no honest pixel claim. Because they are approximate the rail
 * is an **annotation, not a scrollbar** — no drag-to-scrub, no viewport band,
 * and the container never takes the pointer (only the marks do, when
 * interactive) so the native scrollbar keeps working through the paint. Peeks
 * read `items`, never the DOM: the row a mark describes is usually unmounted.
 */

export interface ScrubberProps {
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  /** The catch-up boundary's item index, when the recap is spliced in. */
  recapItemIndex?: number
  /** Bookmarked item indices. Paint only — no store, no set affordance. */
  bookmarks?: readonly number[]
  /** The sub-agent takeover's parent id, when this rail belongs to a frame —
   * what "top level" means to the mark walk (see `buildMarks`). */
  frameParentId?: string
  /** Whether the rail answers the pointer (hover peek, click to jump). False
   * renders passive paint. */
  interactive?: boolean
  /** Jump to an item index. The caller owns the row mapping — item indices are
   * not row indices (`rowIndexForItem`). */
  onJumpToItem?: (itemIndex: number) => void
  className?: string
}

/** `first` is the member the pointer resolved to — see {@link nearestMember}. */
const peekContent = (
  cluster: Cluster,
  first: Mark | undefined,
  items: readonly TranscriptItem[],
  pendingApprovals: readonly PermissionRequest[],
): ReactNode => {
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
      // The merged mark's peek carries both halves: the message the turn ended
      // on, and the done-line (with its reasons, when it failed).
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
          {/* The first non-blank line of what the tool said back. */}
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

  // A peek is a snapshot of the cluster it was opened on; drop it when the
  // transcript changes underneath rather than describe vanished items.
  useEffect(() => {
    setPeek(null)
  }, [items])

  // The peek can be taller than the space beside its mark — clamp it into the
  // rail after it has a measured height.
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

  /** A pointer's y in rail space. */
  const railY = (clientY: number): number => clientY - (railRef.current?.getBoundingClientRect().top ?? 0)

  const activate = (cluster: Cluster, clientY: number) => {
    if (cluster.kind === 'approval' && cluster.marks.length === 0) {
      // The approval prompt renders below the transcript — the closest an
      // item jump can take the reader is the tail.
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

  // `aria-hidden` either way: the rail duplicates what the transcript carries,
  // and the native scrollbar stays the accessible scroll surface.
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
                // A chain-merged bar can span the rail; sliding along it
                // retargets the peek to the member under the pointer.
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
