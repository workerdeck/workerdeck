import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { parentOf } from './blocks.ts'
import { TerminalSurface } from './surface.tsx'

/**
 * The overview ruler — VS Code's strip beside the minimap, with this
 * transcript's own semantics.
 *
 * A 12px rail over the scroller's right edge, two lanes of 6px: **left** is
 * what you typed (blue), **right** each turn's final response and its
 * `turn_result` as one merged mark (white; red when the turn failed).
 * Everything else spans the full 12px as an annotation: an error, the pending
 * approval (pinned at the foot), a bookmark (paint only — the store is the
 * client's) and the catch-up seam. A mark is its row's extent at rail scale,
 * floored at 2px; marks merge when closer than a pixel, loudest colour
 * winning.
 *
 * Positions are **pixel space**, not index space: mark y = the row's
 * virtualizer offset over `getTotalSize()`, honest only because `height.ts`
 * feeds `estimateSize`. That is also why the rail can be a real scrollbar —
 * drag writes `scrollTop` directly (via `stopScroll()`, the follow spring's
 * off switch; the rail is a third writer of `scrollTop`). The peek renders
 * from `items`, never the DOM — the row it describes is usually unmounted.
 * Under `affordances={false}` the rail is passive paint and the native
 * scrollbar stays.
 */

type Lane = 'l' | 'r' | 'f'
type MarkKind = 'user' | 'subagent' | 'turn' | 'turnFailed' | 'toolFailed' | 'error' | 'approval' | 'recap' | 'bookmark'

type Mark = {
  kind: MarkKind
  /** The jump anchor (for a turn mark: the paired response). −1 for recap. */
  itemIndex: number
  rowIndex: number
  /** The `turn_result` behind a center mark — the peek shows its done-line. */
  turnIndex?: number
}

/** Members keep their own y: a dense transcript chain-merges a lane into one
 * tall bar, and the bar answers the pointer by its *nearest member* — a click
 * mid-bar must not act on the mark that happened to found the cluster. */
type Cluster = { lane: Lane; kind: MarkKind; y: number; h: number; marks: { mark: Mark; y: number }[] }

/** The member closest to a rail-space y — what a press or peek on a merged
 * cluster resolves to. */
const nearestMember = (cluster: Cluster, y: number): Mark | undefined => {
  let best: { mark: Mark; y: number } | undefined
  for (const member of cluster.marks) {
    if (!best || Math.abs(member.y - y) < Math.abs(best.y - y)) {
      best = member
    }
  }
  return best?.mark
}

/**
 * The two lanes are **channels, not classes**: left is what went *in* (your
 * prompts, the sub-agents you dispatched), right is what came *out* (each
 * turn's answer, and everything that went wrong producing one — every failure
 * in one column). Full width is reserved for what is not a channel at all: a
 * waiting approval, a bookmark, the catch-up seam.
 */
const LANE: Record<MarkKind, Lane> = {
  user: 'l',
  // Delegated work is input — and this mark is a folded `Task`'s one signal
  // that its region is there at all.
  subagent: 'l',
  turn: 'r',
  turnFailed: 'r',
  // A failed tool call is something the run produced, not an alarm lane of its
  // own; its LOUDNESS rank and 55% strength keep it from shouting over turns.
  toolFailed: 'r',
  error: 'r',
  approval: 'f',
  recap: 'f',
  bookmark: 'f',
}

/** Who wins the colour when marks merge. */
const LOUDNESS: Record<MarkKind, number> = {
  approval: 7,
  error: 6,
  turnFailed: 5,
  // Under `error` and over `turn`: a failure a pixel from a turn end keeps the
  // cluster red, but a session error a pixel away keeps the cluster.
  toolFailed: 4,
  user: 3,
  turn: 2,
  bookmark: 1,
  // Only ever weighed against `user`, and the prompt wins: the sub-agent band
  // is the annotation on it.
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

// The floor, not the height: a mark spans its row's extent at rail scale. Hit
// reliability does not ride on mark height — the pointer's target is the
// 6px-wide lane, resolved through `nearestMember`.
const MIN_MARK = 2

/**
 * Rail pixels per content pixel — the one scale both the marks and the
 * viewport band are drawn at. The denominator is `max(totalSize, viewportH)`,
 * never `totalSize` alone: a transcript shorter than its viewport would
 * otherwise give the band a height of thousands of pixels, and the rail is
 * absolutely positioned *within the scroller*, so that overflow becomes real
 * scrollable height below a short session. Clamped, the rail represents the
 * viewport when everything fits, the band fills it exactly, and `bandH` can
 * structurally never exceed `railH`.
 */
export function railScale(railH: number, totalSize: number, viewportH: number): number {
  return totalSize > 0 ? railH / Math.max(totalSize, viewportH) : 0
}

/**
 * The right lane is anchored on **the answer, not the turn end**: a turn's
 * mark is emitted for the last top-level assistant message of each segment,
 * and a `turn_result` (when there is one) *decorates* it — failed colour,
 * `turnIndex` for the peek's done-line — rather than conjuring it. Building
 * from `turn_result` alone is history-blind: `#backfillHistory` maps only
 * `user`/`assistant` entries, so a replayed session carries no turn rows and
 * the whole white lane comes back empty.
 */
type Segment = { response?: number; turn?: number; failed?: boolean }

const doneLine = (turn: Extract<TranscriptItem, { kind: 'turn_result' }>): string =>
  `${turn.isError ? turn.subtype : 'done'} · ${formatDuration(turn.durationMs)} · ${formatCost(turn.totalCostUsd)}`

const excerpt = (item: TranscriptItem): string => {
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
  /**
   * The sub-agent takeover's parent id, when this rail belongs to a frame —
   * **what "top level" means here**. Several rules mark only items at the
   * conversation's own level; inside a frame every item has a parent by
   * construction, so the level must be a parameter (`undefined` at the top,
   * the frame's id inside one) or the frame's rail marks nothing.
   */
  frameParentId?: string
  /** Item index → virtual row index (the off-by-a-fold mapping; see
   * `rowIndexForItem` in `agent/Transcript.tsx`). */
  rowIndexFor: (itemIndex: number) => number
  /** A virtual row's offset in content space — the virtualizer's measurements,
   * which the height calculator keeps honest for unmounted rows. */
  offsetOfRow: (rowIndex: number) => number
  /** A virtual row's height in content space, same source — what a mark's own
   * height is scaled from. */
  sizeOfRow: (rowIndex: number) => number
  /** Where an item sits inside a row shared with other items — a task block's
   * absorbed child or a folded run's member (`positionInRow` in
   * `agent/transcript-rows.ts`). Optional and additive: without it every mark
   * spans its row's extent, which for an expanded task block is the whole
   * subagent area. */
  positionInRow?: (itemIndex: number) => { ordinal: number; count: number } | undefined
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

/**
 * Exported for `test/scrubber.test.ts` and nothing else — not part of the
 * package's surface. Both bugs this function has shipped were pure-logic ones
 * a unit test catches.
 */
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
  const marks: Mark[] = []
  // By `parentToolUseId`, never by the spawning call's *name* (`Task` is only
  // a convention — a background agent arrives as `Agent`). Same membership
  // rule `terminalBlocks` folds by.
  const subagentParents = new Set<string>()
  for (const item of items) {
    const parent = parentOf(item)
    if (parent !== undefined) {
      subagentParents.add(parent)
    }
  }
  // The **outcome** call of each row: the last top-level tool call the row
  // holds. A failed call is marked only when it is one of these — see the
  // `toolFailed` branch below.
  const rowOutcome = new Map<number, number>()
  items.forEach((item, index) => {
    if (item.kind !== 'tool_call' || parentOf(item) !== frameParentId) {
      return
    }
    rowOutcome.set(rowIndexFor(index), index)
  })
  // One right-lane mark per segment, emitted when the segment closes. A segment
  // is closed by the next prompt, by its own turn end, or by running out of
  // items — that last one is what a replayed history is made of.
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
    // The dispatch itself, marked at its row (the folded `Task` block, so the
    // band tracks its open/closed extent). Deliberately NOT part of the chain
    // below: a `Task` whose own result errored earns a red tick in the
    // response lane *and* this band in the input lane — one says a sub-agent
    // ran here, the other says it came back broken.
    if (item.kind === 'tool_call' && subagentParents.has(item.id)) {
      marks.push({ kind: 'subagent', itemIndex: index, rowIndex: rowIndexFor(index) })
    }
    // Top-level prompts only: a subagent's brief is a `user` item too, and it
    // would both paint a "you" mark nobody typed and close the segment
    // mid-turn, mis-anchoring the turn mark.
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
      // **The rail marks what the transcript reddens.** A call is its row's
      // OUTCOME when it is top level and no later top-level call shares its
      // row: for a folded run that is `runFailed`'s last member, for a lone
      // call the call, for a `Task` the task itself (its children are not top
      // level — `taskFailed`, agreeing). A recovered mid-run failure marks
      // nothing here: a red mark beside nothing red sends a reader hunting for
      // damage that is not there. Both spellings of failure are needed — an
      // out-of-loop execution failure sets `status` with no `is_error` block,
      // and an engine can flag `is_error` on a call not yet settled.
      item.kind === 'tool_call' &&
      (item.status === 'failed' || item.result?.isError === true) &&
      rowOutcome.get(rowIndexFor(index)) === index
    ) {
      marks.push({ kind: 'toolFailed', itemIndex: index, rowIndex: rowIndexFor(index) })
    } else if (item.kind === 'assistant_text' && parentOf(item) === frameParentId) {
      if (frameParentId !== undefined) {
        // Inside a frame every narration step is its own mark: a sub-agent's
        // stream carries no prompts and no `turn_result`, so the segment
        // machinery would fold everything into one mark at the final report.
        marks.push({ kind: 'turn', itemIndex: index, rowIndex: rowIndexFor(index) })
        return
      }
      // The live one included, deliberately: a turn in flight has no turn end
      // yet, and it must still be on the rail. It cannot double up — the
      // reducer settles this item in the same action that appends the
      // `turn_result` that closes the segment.
      segment.response = index
    }
  })
  // A history that ends mid-segment still has an answer in it.
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
    // A mark's height is its row's, at rail scale, floored at the hit target —
    // EXCEPT an item that SHARES its row (a task block's absorbed child, a
    // folded run's member): there the row's extent is mostly other items'
    // work, and expanded it is the entire subagent area, so such a mark is a
    // tick at its fractional position within the row. `sizeOfRow` is the
    // virtualizer's *measurement*, so expansion is reflected without the
    // scrubber holding expansion state (which it deliberately cannot —
    // `height.ts`'s "unmounted is collapsed" invariant). The fraction is
    // approximate on purpose: exactness would cost the scrubber the one thing
    // it must not know. Applied to every kind (a bookmark on an absorbed child
    // has the identical bug); `recap` is `itemIndex: -1`, hence the guard.
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
      // Merge when the gap is under a pixel; the merged mark grows and takes
      // the loudest member's colour.
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
  // The approval is not an item — the prompt renders below the transcript —
  // so its mark pins at the rail's foot, where the prompt is.
  if (pendingApprovals.length > 0) {
    clusters.push({
      // `LANE.approval`, not a literal: a hardcoded lane here once silently
      // kept an old layout after the map moved on.
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
  /** The member the pointer resolved to — see {@link nearestMember}. */
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
      // The merged mark's peek carries both halves: the message the turn ended
      // on, and the done-line (with its reasons, when it failed).
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
          {/* The first non-blank line of what the tool said back — the thing
              worth peeking at. */}
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

  // The band tracks the scroller's own scroll events, not the `scrollOffset`
  // prop: the virtualizer notifies React only when the virtual row *range*
  // changes, so scrolling inside one tall row would leave the band lagging and
  // snapping. The prop seeds the first paint.
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

  // A peek is a snapshot; if the transcript changes underneath, drop it rather
  // than describe rows that no longer exist.
  useEffect(() => {
    setPeek(null)
  }, [props.items])

  // Wheel over the rail scrolls the transcript. Manual listener because it
  // must preventDefault (React's root wheel listeners are passive).
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

  // The peek can be taller than the space beside its mark — clamp it into the
  // rail after it has a measured height.
  useLayoutEffect(() => {
    const element = peekRef.current
    if (!element || !peek) {
      return
    }
    const height = element.offsetHeight
    const railHeight = bodyRef.current?.clientHeight ?? 0
    element.style.top = `${Math.max(4, Math.min(railHeight - height - 4, peek.y - height / 2))}px`
  }, [peek])

  // Memoized against content and geometry, NOT per render: the live scroll
  // offset re-renders this component on every scroll event, and rebuilding
  // clusters there is O(session) work per wheel tick. `rowIndexFor`/
  // `offsetOfRow` are closures rebuilt every parent render and deliberately
  // not dependencies; `totalSize` stands in for the measurements behind them —
  // row heights cannot move a mark without moving the total. `viewportH` rides
  // here because it is the scale's other term when the transcript is shorter
  // than the window.
  const clusters = useMemo(
    () => (railH > 0 ? buildClusters(props, railH) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.items, props.bookmarks, props.recapRow, props.pendingApprovals, totalSize, railH, viewportH],
  )
  const scale = railScale(railH, totalSize, viewportH)
  const bandH = Math.max(2, Math.min(railH, Math.round(viewportH * scale)))
  // Clamped against the rail's foot as well as its head: an overscroll bounce
  // drives `liveOffset` past `totalSize - viewportH` for a frame or two.
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

  /** A pointer's y in rail space. */
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

  // The rail is a scrollbar to assistive tech when it acts like one, and
  // invisible when it is passive paint (a decorative copy of information the
  // transcript itself carries).
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
                // The rail is about to write scrollTop; this is the follow
                // spring's own off switch, same as every other jump.
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
                // A clean press: on a mark it is a jump; on the ground it is a
                // scrub to that spot — scrollbar semantics.
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
                  // A chain-merged bar can span the rail; sliding along it
                  // retargets the peek to the member under the pointer.
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
