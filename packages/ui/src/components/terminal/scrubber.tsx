import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { TerminalSurface } from './surface.tsx'

/**
 * The overview ruler — VS Code's strip beside the minimap, with this
 * transcript's own semantics.
 *
 * A 12px rail over the scroller's right edge, two lanes of 6px: **left** is
 * what you typed (blue), **right** is each turn's final response and its
 * `turn_result` as *one* merged mark (white; red when the turn failed — the
 * turn boundary is the response's address, so two ticks would answer no
 * question the peek doesn't). Those two are the conversation, and they are what
 * you navigate by.
 *
 * Everything else spans the **full 12px** and is an annotation rather than a
 * step: an error, the pending approval (pinned at the foot, pulsing), a
 * bookmark (magenta — paint only; the store is the client's, the way watermarks
 * are) and the catch-up seam (dashed). A mark is its row's extent at rail
 * scale, floored at 2px, drawn as a solid 2px head with a 25% tail; marks
 * merge when closer than a pixel, loudest colour winning.
 *
 * Positions are **pixel space**, not index space: mark y = the row's
 * virtualizer offset over `getTotalSize()`. That is only honest because the
 * height calculator (`height.ts`) feeds `estimateSize`, so an unmounted row's
 * offset is computed rather than guessed — the rail is the calculator's
 * payoff, and it is why the rail can be a *real scrollbar*: drag scrubs
 * `scrollTop` directly, and the native scrollbar is hidden while an
 * interactive rail is mounted.
 *
 * The peek renders from `items`, never the DOM — the row it describes is
 * usually unmounted, so there is nothing to clone. A click is a jump through
 * the transcript's re-aim closure (`onJumpToRow`), which starts with
 * `stopScroll()`: the rail is a third writer of `scrollTop` beside the follow
 * spring and the virtualizer's corrections, and that call is the library's
 * own "the user is leaving the bottom" switch.
 *
 * Under `affordances={false}` the rail is passive paint: `pointer-events:
 * none`, no peek, no drag, no click — and the native scrollbar stays, working
 * straight through the paint.
 */

type Lane = 'l' | 'r' | 'f'
type MarkKind = 'user' | 'turn' | 'turnFailed' | 'error' | 'approval' | 'recap' | 'bookmark'

type Mark = {
  kind: MarkKind
  /** The jump anchor (for a turn mark: the paired response). −1 for recap. */
  itemIndex: number
  rowIndex: number
  /** The `turn_result` behind a center mark — the peek shows its done-line. */
  turnIndex?: number
}

/** Members keep their own y: a dense transcript chain-merges a lane into one
 * tall bar (600 prompts over a 300px rail IS a solid stripe, exactly as VS
 * Code draws dense decorations), and the bar answers the pointer by its
 * *nearest member* — a click or peek at the middle of the bar must not act on
 * the first mark that happened to found the cluster. */
type Cluster = { lane: Lane; kind: MarkKind; y: number; h: number; marks: { mark: Mark; y: number }[] }

/** The member closest to a rail-space y — what a press or peek on a merged
 * cluster resolves to. */
function nearestMember(cluster: Cluster, y: number): Mark | undefined {
  let best: { mark: Mark; y: number } | undefined
  for (const member of cluster.marks)
    if (!best || Math.abs(member.y - y) < Math.abs(best.y - y)) best = member
  return best?.mark
}

/**
 * Two lanes and a full-width annotation, which is a claim about what a rail is
 * *for*: the two things you navigate by are what you asked and what came back,
 * so they get a lane each and split the rail evenly. Everything else — an error,
 * a waiting approval, a bookmark, the catch-up seam — is an **annotation on the
 * run** rather than a step through it, so it spans the full width and reads as
 * a different class of thing rather than as a third column of steps.
 *
 * It also buys the marks their width back: three lanes in a 16px rail is 5px a
 * lane, which is a hard target to hit and a hard colour to see.
 */
const LANE: Record<MarkKind, Lane> = {
  user: 'l',
  turn: 'r',
  turnFailed: 'r',
  error: 'f',
  approval: 'f',
  recap: 'f',
  bookmark: 'f',
}

/** Who wins the colour when marks merge. */
const LOUDNESS: Record<MarkKind, number> = {
  approval: 6,
  error: 5,
  turnFailed: 4,
  user: 3,
  turn: 2,
  bookmark: 1,
  recap: 0,
}

const KIND_NAME: Record<MarkKind, string> = {
  user: 'you',
  turn: 'response · turn end',
  turnFailed: 'turn failed',
  error: 'error',
  approval: 'pending approval',
  recap: 'catch-up boundary',
  bookmark: 'bookmark',
}

// The floor, not the height: a mark spans its row's actual extent at rail
// scale, so a one-line prompt is a tick and a hundred-line response is a bar —
// the rail is a map, and on a map a long answer looks long. 2px keeps a tick
// findable while the CSS draws only the first 2px solid (the rest is a 25%
// tail); the pointer's real target is the 6px-wide lane, and a press resolves
// through `nearestMember`, so hit reliability does not ride on mark height.
const MIN_MARK = 2

/** The final response a turn end pairs with: the last top-level, settled
 * assistant message between the previous boundary and the turn row. */
function pairedResponse(items: readonly TranscriptItem[], turnIndex: number): number | undefined {
  for (let j = turnIndex - 1; j >= 0; j--) {
    const item = items[j]!
    if (item.kind === 'user' || item.kind === 'turn_result') return undefined
    if (item.kind === 'assistant_text' && !item.streaming && item.parentToolUseId == null) return j
  }
  return undefined
}

const doneLine = (turn: Extract<TranscriptItem, { kind: 'turn_result' }>): string =>
  `${turn.isError ? turn.subtype : 'done'} · ${formatDuration(turn.durationMs)} · ${formatCost(turn.totalCostUsd)}`

function excerpt(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant_text':
    case 'thinking':
    case 'notice':
      return item.text
    case 'tool_call':
      return `${item.name}(${toolInputPreview(item.input)})`
    case 'turn_result':
      return doneLine(item)
    case 'file_delivered':
      return item.path
    default:
      return ''
  }
}

export interface TerminalScrubberProps {
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  /** The catch-up boundary's virtual row, when the recap is spliced in. */
  recapRow?: { rowIndex: number; label: string }
  /** Bookmarked item indices. Paint only — no store, no set affordance. */
  bookmarks: readonly number[]
  /** Item index → virtual row index (the off-by-a-fold mapping; see
   * `rowIndexForItem` in `agent/Transcript.tsx`). */
  rowIndexFor: (itemIndex: number) => number
  /** A virtual row's offset in content space — the virtualizer's measurements,
   * which the height calculator keeps honest for unmounted rows. */
  offsetOfRow: (rowIndex: number) => number
  /** A virtual row's height in content space, same source — what a mark's own
   * height is scaled from. */
  sizeOfRow: (rowIndex: number) => number
  totalSize: number
  scrollOffset: number
  viewportH: number
  /** The transcript's re-aim jump (stopScroll + aim + exact finish). */
  onJumpToRow: (rowIndex: number) => void
  /** False renders passive paint: no pointer events at all. */
  interactive: boolean
  fontSize?: number
  lineHeight?: number
}

function buildClusters(
  props: TerminalScrubberProps,
  railH: number,
): Cluster[] {
  const {
    items,
    bookmarks,
    recapRow,
    pendingApprovals,
    rowIndexFor,
    offsetOfRow,
    sizeOfRow,
    totalSize,
  } = props
  const marks: Mark[] = []
  items.forEach((item, index) => {
    if (item.kind === 'user') {
      marks.push({ kind: 'user', itemIndex: index, rowIndex: rowIndexFor(index) })
    } else if (item.kind === 'turn_result') {
      const anchor = pairedResponse(items, index) ?? index
      marks.push({
        kind: item.isError ? 'turnFailed' : 'turn',
        itemIndex: anchor,
        rowIndex: rowIndexFor(anchor),
        turnIndex: index,
      })
    } else if (item.kind === 'notice' && item.level === 'error') {
      marks.push({ kind: 'error', itemIndex: index, rowIndex: rowIndexFor(index) })
    }
  })
  for (const index of bookmarks)
    if (index >= 0 && index < items.length)
      marks.push({ kind: 'bookmark', itemIndex: index, rowIndex: rowIndexFor(index) })
  if (recapRow) marks.push({ kind: 'recap', itemIndex: -1, rowIndex: recapRow.rowIndex })

  const scale = totalSize > 0 ? railH / totalSize : 0
  const lanes = new Map<Lane, { mark: Mark; y: number; h: number }[]>()
  for (const mark of marks) {
    // A mark's height is its row's, at rail scale, floored at the hit target —
    // the row the mark *anchors* (for a turn, the final response), which is
    // where the reader lands and what they came to gauge the size of.
    const h = Math.max(MIN_MARK, Math.round(sizeOfRow(mark.rowIndex) * scale))
    const y = Math.min(Math.max(0, railH - h), Math.round(offsetOfRow(mark.rowIndex) * scale))
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
      // Merge when the gap is under a pixel; the merged mark grows and takes
      // the loudest member's colour.
      if (current && y <= current.y + current.h + 1) {
        current.h = Math.max(current.h, y + h - current.y)
        if (LOUDNESS[mark.kind] > LOUDNESS[current.kind]) current.kind = mark.kind
        current.marks.push({ mark, y })
      } else {
        current = { lane, kind: mark.kind, y, h, marks: [{ mark, y }] }
        clusters.push(current)
      }
    }
  }
  // The approval is not an item — the prompt renders below the transcript —
  // so its mark pins at the rail's foot, where the prompt is.
  if (pendingApprovals.length > 0)
    clusters.push({
      // `LANE.approval`, not a literal: this cluster is built by hand because it
      // has no item to derive a position from, and a hardcoded lane here is how
      // it silently kept the old three-lane layout after the map moved on.
      lane: LANE.approval,
      kind: 'approval',
      y: Math.max(0, railH - MIN_MARK),
      h: MIN_MARK,
      marks: [],
    })
  return clusters
}

function peekContent(
  cluster: Cluster,
  /** The member the pointer resolved to — see {@link nearestMember}. */
  first: Mark | undefined,
  { items, pendingApprovals, recapRow }: TerminalScrubberProps,
): ReactNode {
  const more = cluster.marks.length > 1 ? ` · ${cluster.marks.length} marks` : ''
  let body: ReactNode = null
  if (cluster.kind === 'approval') {
    const request = pendingApprovals[0]
    body = request ? (
      <>
        <div data-tone='bright'>{request.title ?? 'Permission required'}</div>
        <div className='term-scrub-ex' data-tone='fg'>
          {`${request.displayName ?? request.toolName}(${toolInputPreview(request.input)})`}
        </div>
      </>
    ) : null
  } else if (cluster.kind === 'recap' && !first) {
    body = <div data-tone='faint'>※ {recapRow?.label}</div>
  } else if (first) {
    const item = items[first.itemIndex]
    if (first.kind === 'recap') {
      body = <div data-tone='faint'>※ {recapRow?.label}</div>
    } else if (first.kind === 'turn' || first.kind === 'turnFailed') {
      // The merged mark's peek carries both halves: the message the turn ended
      // on, and the done-line (with its reasons, when it failed).
      const turn = first.turnIndex === undefined ? undefined : items[first.turnIndex]
      body = (
        <>
          {item?.kind === 'assistant_text' ? (
            <div className='term-scrub-ex' data-tone='fg'>
              <span data-tone='dim'>● </span>
              {item.text}
            </div>
          ) : null}
          {turn?.kind === 'turn_result' ? (
            <>
              <div data-tone={turn.isError ? 'red' : 'faint'}>{doneLine(turn)}</div>
              {turn.errors?.map((message, index) => (
                <div key={index} data-tone='red'>
                  {message}
                </div>
              ))}
            </>
          ) : null}
        </>
      )
    } else if (item) {
      body = (
        <div className='term-scrub-ex' data-tone={first.kind === 'error' ? 'red' : 'fg'}>
          {first.kind === 'user' ? <span data-tone='dim'>{'❯ '}</span> : null}
          {excerpt(item)}
        </div>
      )
    }
  }
  return (
    <>
      <div data-tone='faint'>
        {KIND_NAME[first?.kind ?? cluster.kind]}
        {more}
      </div>
      {body}
    </>
  )
}

export function TerminalScrubber(props: TerminalScrubberProps) {
  const {
    scrollOffset,
    viewportH,
    totalSize,
    onJumpToRow,
    interactive,
    fontSize,
    lineHeight,
  } = props
  const stick = useStickToBottomContext()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const peekRef = useRef<HTMLDivElement | null>(null)
  const [railH, setRailH] = useState(0)
  const [peek, setPeek] = useState<{ cluster: Cluster; mark: Mark | undefined; y: number } | null>(
    null,
  )
  const drag = useRef<{ y: number; moved: boolean; target: EventTarget | null } | null>(null)

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setRailH(element.clientHeight))
    observer.observe(element)
    setRailH(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // The band tracks the scroller's own scroll events, not the `scrollOffset`
  // prop: the virtualizer notifies React only when the virtual row *range*
  // changes, and scrolling inside one tall row changes none — the prop then
  // refreshes only when `isScrolling` flips at the end, which reads as the
  // band lagging the drag and snapping into place. The prop still seeds the
  // first paint, before this listener's first event.
  const [liveOffset, setLiveOffset] = useState(scrollOffset)
  useEffect(() => {
    const scroller = stick.scrollRef.current
    if (!scroller) return
    const onScroll = () => setLiveOffset(scroller.scrollTop)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    setLiveOffset(scroller.scrollTop)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [stick.scrollRef])

  // A peek is a snapshot of the cluster it was opened on; if the transcript
  // changes underneath (a fixture/session swap, a burst of new items), drop it
  // rather than describe rows that no longer exist.
  useEffect(() => {
    setPeek(null)
  }, [props.items])

  // Wheel over the rail scrolls the transcript. Manual listener because it
  // must preventDefault (React's root wheel listeners are passive).
  useEffect(() => {
    if (!interactive) return
    const element = bodyRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      const scroller = stick.scrollRef.current
      if (!scroller) return
      scroller.scrollTop += event.deltaY
      event.preventDefault()
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [interactive, stick.scrollRef])

  // The peek can be taller than the space beside its mark — clamp it into the
  // rail after it has a measured height.
  useLayoutEffect(() => {
    const element = peekRef.current
    if (!element || !peek) return
    const height = element.offsetHeight
    const railHeight = bodyRef.current?.clientHeight ?? 0
    element.style.top = `${Math.max(4, Math.min(railHeight - height - 4, peek.y - height / 2))}px`
  }, [peek])

  // Memoized against content and geometry, NOT recomputed per render: the live
  // scroll offset re-renders this component on every scroll event, and
  // rebuilding the clusters there walks every item — O(session) work per
  // wheel tick for output that only changes when content or measurements do.
  // `rowIndexFor`/`offsetOfRow` are closures rebuilt every parent render and
  // deliberately not dependencies; `totalSize` stands in for the measurements
  // behind them — row heights cannot move a mark without moving the total.
  const clusters = useMemo(
    () => (railH > 0 ? buildClusters(props, railH) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.items, props.bookmarks, props.recapRow, props.pendingApprovals, totalSize, railH],
  )
  const scale = totalSize > 0 ? railH / totalSize : 0
  const bandTop = Math.round(liveOffset * scale)
  const bandH = Math.max(2, Math.round(viewportH * scale))

  const scrub = (clientY: number) => {
    const rail = bodyRef.current
    const scroller = stick.scrollRef.current
    if (!rail || !scroller) return
    const rect = rail.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2
  }

  /** A pointer's y in rail space. */
  const railY = (clientY: number): number =>
    clientY - (bodyRef.current?.getBoundingClientRect().top ?? 0)

  const activate = (cluster: Cluster, clientY: number) => {
    if (cluster.kind === 'approval' && cluster.marks.length === 0) {
      void stick.scrollToBottom()
      return
    }
    const mark = nearestMember(cluster, railY(clientY))
    if (mark) onJumpToRow(mark.rowIndex)
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

  // The rail is a scrollbar to assistive tech when it acts like one, and
  // invisible when it is passive paint (a decorative copy of information the
  // transcript itself carries).
  const maxOffset = Math.max(1, totalSize - viewportH)
  return (
    <TerminalSurface
      fontSize={fontSize}
      lineHeight={lineHeight}
      className='term-scrubber'
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
        : { 'aria-hidden': true })}>
      <div
        ref={bodyRef}
        className='term-scrubber-body'
        {...(interactive
          ? {
              onPointerDown: (event) => {
                // The rail is about to write scrollTop; this is the follow
                // spring's own off switch, same as every other jump.
                stick.stopScroll()
                drag.current = { y: event.clientY, moved: false, target: event.target }
                event.currentTarget.setPointerCapture(event.pointerId)
              },
              onPointerMove: (event) => {
                const state = drag.current
                if (!state) return
                if (!state.moved && Math.abs(event.clientY - state.y) < 3) return
                state.moved = true
                setPeek(null)
                scrub(event.clientY)
              },
              onPointerUp: (event) => {
                const state = drag.current
                drag.current = null
                if (!state || state.moved) return
                // A clean press: on a mark it is a jump; on the ground it is a
                // scrub to that spot — scrollbar semantics.
                const mark = (state.target as HTMLElement | null)?.closest?.('[data-ci]')
                const index = mark ? Number((mark as HTMLElement).dataset.ci) : Number.NaN
                if (Number.isInteger(index) && clusters[index])
                  activate(clusters[index]!, event.clientY)
                else scrub(event.clientY)
              },
            }
          : null)}>
        <div className='term-scrub-band' style={{ top: bandTop, height: bandH }} />
        <div
          className='term-scrub-cursor'
          style={{ top: Math.min(bandTop, Math.max(0, railH - 2)) }}
        />
        {clusters.map((cluster, index) => (
          <div
            key={index}
            data-ci={index}
            className='term-scrub-mark'
            data-lane={cluster.lane}
            data-kind={cluster.kind}
            style={{ top: cluster.y, height: cluster.h }}
            {...(interactive
              ? {
                  onPointerEnter: (event) => showPeek(cluster, event.clientY),
                  // A chain-merged bar can span the rail; sliding along it
                  // retargets the peek to the member under the pointer.
                  onPointerMove: (event) => {
                    if (!drag.current) showPeek(cluster, event.clientY)
                  },
                  onPointerLeave: () => setPeek(null),
                }
              : null)}
          />
        ))}
        {peek ? (
          <div ref={peekRef} className='term-scrub-peek' style={{ top: peek.y }}>
            {peekContent(peek.cluster, peek.mark, props)}
          </div>
        ) : null}
      </div>
    </TerminalSurface>
  )
}
