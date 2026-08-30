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
 * tall bar (600 prompts over a 300px rail IS a solid stripe, exactly as VS
 * Code draws dense decorations), and the bar answers the pointer by its
 * *nearest member* — a click or peek at the middle of the bar must not act on
 * the first mark that happened to found the cluster. */
type Cluster = { lane: Lane; kind: MarkKind; y: number; h: number; marks: { mark: Mark; y: number }[] }

/** The member closest to a rail-space y — what a press or peek on a merged
 * cluster resolves to. */
function nearestMember(cluster: Cluster, y: number): Mark | undefined {
  let best: { mark: Mark; y: number } | undefined
  for (const member of cluster.marks) {
    if (!best || Math.abs(member.y - y) < Math.abs(best.y - y)) {
      best = member
    }
  }
  return best?.mark
}

/**
 * The two lanes are **channels, not classes**: left is what went *in* — your
 * prompts, and the sub-agents you dispatched — and right is what came *out* —
 * each turn's answer, and everything that went wrong producing one. That is the
 * question a reader actually asks of a rail ("where did I say something", "where
 * did it go wrong"), and it puts every failure in one column instead of
 * scattering some down the middle.
 *
 * Full width is reserved for what is not a channel at all: a waiting approval
 * (which is the session asking *you*, pinned at the foot), a bookmark (the
 * reader's own annotation) and the catch-up seam (a boundary across both).
 *
 * It also buys the marks their width back: three lanes in a 16px rail is 5px a
 * lane, which is a hard target to hit and a hard colour to see.
 */
const LANE: Record<MarkKind, Lane> = {
  user: 'l',
  // Delegated work is input: a sub-agent runs because you asked for it, and its
  // stretch of the transcript is *your* dispatch rather than the session's
  // answer. It also gives a folded `Task` its one honest signal on the rail —
  // collapsed, sixty rows of somebody else's working are one line, and this is
  // the mark that says the region is there at all.
  subagent: 'l',
  turn: 'r',
  turnFailed: 'r',
  // Output, with the answers: a failed tool call is something the run produced.
  // It had been full-width on the argument that it is an alarm rather than a
  // step — but "alarm" is not a lane, and half the failures ending up down the
  // middle while `turnFailed` sat in the right lane meant no single column
  // answered "did anything go wrong". Its rank in LOUDNESS and its 55% strength
  // are what keep it from shouting over the turns it now sits beside.
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
  // Under `error`, which is the rank that actually does work: both are lane `f`,
  // so a session error and a tool failure a pixel apart merge and the error must
  // keep the cluster. (It cannot merge with `turnFailed` — that is lane `r`, and
  // merging is per lane.) A failed tool call the model recovered from is routine
  // in a way a session error is not, hence quieter here and at 55% in the CSS.
  // It now shares the response lane with the turn marks, which is the rank that
  // matters: a failure a pixel from a turn end keeps the cluster red.
  toolFailed: 4,
  user: 3,
  turn: 2,
  bookmark: 1,
  // Lane `l`, so this is only ever weighed against `user`, and a prompt wins:
  // the prompt is the step you navigate by and the sub-agent band is the
  // annotation on it. (It ties with `bookmark`, which it can never meet.)
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

// The floor, not the height: a mark spans its row's actual extent at rail
// scale, so a one-line prompt is a tick and a hundred-line response is a bar —
// the rail is a map, and on a map a long answer looks long. 2px keeps a tick
// findable while the CSS draws only the first 2px solid (the rest is a 25%
// tail); the pointer's real target is the 6px-wide lane, and a press resolves
// through `nearestMember`, so hit reliability does not ride on mark height.
const MIN_MARK = 2

/**
 * Rail pixels per content pixel — the one scale both the marks and the viewport
 * band are drawn at, so they cannot disagree about where a row sits.
 *
 * The denominator is `max(totalSize, viewportH)` and never `totalSize` alone.
 * A transcript **shorter than its viewport** is the case that forces it: with
 * 90px of content in a 906px window, `railH / totalSize` is ~10, and the band
 * — `viewportH * scale` — comes out at 9120px inside a 906px rail. The rail is
 * absolutely positioned *within the scroller*, so that overflow becomes real
 * scrollable height: a short session grew ~8000px of empty space below it, and
 * the reader could scroll away from the only three rows there were.
 *
 * Clamping the denominator says the thing that is actually true: when
 * everything fits, the rail represents the **viewport**, not the content. The
 * band then fills it exactly (`viewportH * railH / viewportH === railH`), which
 * is what "you are looking at all of it" should look like. It also makes the
 * overflow structurally impossible rather than merely unlikely — `bandH` can
 * never exceed `railH` again, for any content, because `viewportH` can never
 * exceed the denominator.
 */
export function railScale(railH: number, totalSize: number, viewportH: number): number {
  return totalSize > 0 ? railH / Math.max(totalSize, viewportH) : 0
}

/**
 * The right lane is anchored on **the answer, not the turn end**.
 *
 * It used to be built from `turn_result` items alone, which made it silently
 * history-blind: `#backfillHistory` maps only `user` and `assistant` entries, so
 * a session replayed after a gateway restart — or any resumed session — carried
 * no turn rows at all and the whole white lane came back empty. The blue lane
 * survived, which is what made it look like a rendering bug rather than a
 * missing input.
 *
 * So a turn's mark is emitted for the last top-level assistant message of each
 * segment, and a `turn_result` (when there is one) *decorates* it rather than
 * conjuring it — contributing the failed colour and the `turnIndex` its peek
 * shows the done-line from. Live behaviour is unchanged by construction: the
 * item this lands on is exactly the one `pairedResponse` used to find, because
 * a settled `assistant_text` always precedes the `turn_result` that ends it.
 */
type Segment = { response?: number; turn?: number; failed?: boolean }

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
  /**
   * The sub-agent takeover's parent id, when this rail belongs to a frame.
   *
   * **It is what "top level" means here.** Three of the rules below mark only
   * items at the conversation's own level, so that a sub-agent's work is
   * represented by the one band its `Task` row gets rather than by a second set
   * of prompts and answers scattered through the rail. Inside a frame that same
   * test excludes *everything* — every item there has a parent by construction —
   * and the rail came out empty: mounted, banded, and marking nothing on a
   * hundred-tool agent. So the level is a parameter, `undefined` at the top and
   * the frame's id inside one.
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
 * Exported for `test/scrubber.test.ts` and nothing else — it is not part of the
 * package's surface (`index.ts` does not re-export it). Both of the bugs this
 * function has shipped were pure-logic ones a unit test catches: a live answer
 * with no `turn_result` yet went unmarked for the whole two minutes it was the
 * only thing worth navigating to, and a replayed history — which carries no turn
 * rows at all — came back with an empty right lane.
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
  // Which top-level calls a sub-agent ran inside — by `parentToolUseId` and
  // never by the spawning call's *name*: the SDK's own convention is `Task`,
  // but it is a convention (a background agent arrives as `Agent`), and an id
  // that other items demonstrably nest under IS a sub-agent whatever spawned
  // it. The same membership rule `terminalBlocks` folds by, for the same reason.
  const subagentParents = new Set<string>()
  for (const item of items) {
    const parent = parentOf(item)
    if (parent !== undefined) {
      subagentParents.add(parent)
    }
  }
  // The **outcome** call of each row: the last top-level tool call the row
  // holds. A failed call is marked only when it is one of these — see the
  // `toolFailed` branch below for why, and note this needs no block lookup,
  // only `rowIndexFor`.
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
    // The dispatch itself, marked at its row — which is the folded `Task`
    // block, so the band grows to the whole sub-agent area when it is opened
    // and shrinks back to a tick when it is closed. Deliberately NOT part of
    // the chain below: a `Task` whose own result errored earns a red tick in
    // the response lane *and* this band in the input lane, which is the whole
    // point of the two channels — one says a sub-agent ran here, the other says
    // it came back broken. A failed child inside it still marks separately, at
    // its own fraction of the row.
    if (item.kind === 'tool_call' && subagentParents.has(item.id)) {
      marks.push({ kind: 'subagent', itemIndex: index, rowIndex: rowIndexFor(index) })
    }
    // Top-level prompts only, like the answer check below: a subagent's brief
    // is a `user` item too, and it would both paint a "you" mark for something
    // nobody typed and close the segment mid-turn — which mis-anchors the turn
    // mark whenever a task runs between the prompt and the answer.
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
      // **The rail marks what the transcript reddens** — the whole rule, and
      // why this is not simply the per-call predicate it used to be.
      //
      // The row model already decided, twice, that a routine failure the model
      // recovered from is not a failure: `runFailed` colours a folded run by
      // its LAST call, and `taskFailed` colours a `Task` by its OWN result and
      // never a child's. Both were changed from `contains` for the same reason
      // — a normal working session came back painted red, spending the colour
      // that should have been left for the one broken thing on a grep that
      // matched nothing. The rail was deliberately exempted, on the argument
      // that its question ("is there anything worth navigating to") differs
      // from the row's ("how did this end").
      //
      // Measured against a real session, the exemption did not survive: 178
      // tool calls, 9 failed, EIGHT OF THE NINE recovered from inside their own
      // run, no failed turn and no session error — nine alarms on the rail for
      // a transcript that reddens one row. A red mark beside nothing red is
      // worse than no mark: it sends a reader hunting for damage that is not
      // there.
      //
      // One uniform test covers all three cases: a call is its row's OUTCOME
      // when it is top level and no later top-level call shares its row. For a
      // folded run that is exactly `runFailed`'s last member; for a lone call
      // it is the call; and for a `Task` it is the task itself, because its
      // children are not top level — which is `taskFailed`, spelled a third way
      // and agreeing. A failed child inside a sub-agent is therefore no longer
      // marked, the same call `taskFailed` makes. The sub-agent band still says
      // it ran and its own red tick still says it came back broken, every
      // failure is still red on its own row, and the recap still counts them
      // all.
      //
      // The disjunction is unchanged and both spellings are still needed: an
      // out-of-loop execution failure sets `status` with no `is_error` block to
      // read, and an engine can flag `is_error` on a call this reducer has not
      // settled yet.
      item.kind === 'tool_call' &&
      (item.status === 'failed' || item.result?.isError === true) &&
      rowOutcome.get(rowIndexFor(index)) === index
    ) {
      marks.push({ kind: 'toolFailed', itemIndex: index, rowIndex: rowIndexFor(index) })
    } else if (item.kind === 'assistant_text' && parentOf(item) === frameParentId) {
      if (frameParentId !== undefined) {
        // **Inside a frame every narration step is its own mark**, where the
        // conversation gets one per segment. The segment machinery has nothing
        // to work with here — a sub-agent's stream carries no prompts and no
        // `turn_result`, so every step would fold into a single mark at the
        // final report, which is the one place a reader can already get to. An
        // agent's rail is a list of what it said on the way, and that is what
        // makes a fifty-step run navigable.
        marks.push({ kind: 'turn', itemIndex: index, rowIndex: rowIndexFor(index) })
        return
      }
      // The live one included, deliberately: a turn in flight has no turn end
      // yet, which left a two-minute answer unrepresented on the rail for the
      // whole two minutes it was the only thing worth navigating to. The mark's
      // height is its row's, so it grows as the answer does with no extra
      // bookkeeping, and it cannot double up — the reducer settles this item in
      // the same action that appends the `turn_result` that closes the segment.
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
    // the row the mark *anchors* (for a turn, the final response), which is
    // where the reader lands and what they came to gauge the size of.
    //
    // EXCEPT an item that SHARES its row (a task block's absorbed child, a
    // folded run's member): there the row's extent is mostly other items' work,
    // and expanded it is the entire subagent area — one failed child of a
    // hundred-call task used to paint a solid red band down the whole rail.
    // Such a mark is a tick at its fractional position within the row.
    // `sizeOfRow` is the virtualizer's *measurement*, so expansion is reflected
    // with no expansion state here (which the scrubber deliberately cannot see,
    // `height.ts`'s "unmounted is collapsed" invariant being load-bearing):
    // collapsed, the fraction rounds onto the row's one line and siblings merge
    // exactly as before; expanded, the ticks distribute down the block —
    // approximately, since children differ in height, which a 12px rail cannot
    // show and exactness would cost the scrubber the one thing it must not know.
    // Applied here rather than per kind because a bookmark on an absorbed child
    // has the identical bug; `recap` is `itemIndex: -1`, hence the guard.
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
      // `LANE.approval`, not a literal: this cluster is built by hand because it
      // has no item to derive a position from, and a hardcoded lane here is how
      // it silently kept the old three-lane layout after the map moved on.
      lane: LANE.approval,
      kind: 'approval',
      y: Math.max(0, railH - MIN_MARK),
      h: MIN_MARK,
      marks: [],
    })
  }
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
          {/* Which tool failed is rarely the question — `Bash(pnpm test)` is
              what you already expected to see. The first non-blank line of what
              it said back is the thing worth peeking at. */}
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
  // changes, and scrolling inside one tall row changes none — the prop then
  // refreshes only when `isScrolling` flips at the end, which reads as the
  // band lagging the drag and snapping into place. The prop still seeds the
  // first paint, before this listener's first event.
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

  // A peek is a snapshot of the cluster it was opened on; if the transcript
  // changes underneath (a fixture/session swap, a burst of new items), drop it
  // rather than describe rows that no longer exist.
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
    // `viewportH` rides here because it is the scale's other term whenever the
    // transcript is shorter than the window — without it a resize in that
    // regime leaves every mark at the old scale.
    [props.items, props.bookmarks, props.recapRow, props.pendingApprovals, totalSize, railH, viewportH],
  )
  const scale = railScale(railH, totalSize, viewportH)
  const bandH = Math.max(2, Math.min(railH, Math.round(viewportH * scale)))
  // Clamped against the rail's foot as well as its head: an overscroll bounce
  // drives `liveOffset` past `totalSize - viewportH` for a frame or two, and the
  // band is the one child whose top is not already bounded by its own height.
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
        {/* The band is the whole "where am I" answer. It used to carry a 2px
            blue line on its top edge as well; with the band already outlined,
            that was a second indicator of one fact, and the loudest colour on
            the rail spent on it. */}
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
