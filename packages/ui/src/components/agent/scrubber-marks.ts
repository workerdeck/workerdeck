import type { TranscriptItem } from '@workerdeck/react'
import { formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { parentOf } from '../terminal/blocks.ts'

/**
 * The scrubber's mark model, shared between the two rails.
 *
 * The terminal scrubber (`terminal/scrubber.tsx`) positions marks in **pixel
 * space** — the virtualizer's row offsets, honest because the height calculator
 * feeds `estimateSize`. The cards variant has no such claim (proportional text,
 * variable row heights), so its rail (`agent/Scrubber.tsx`) positions marks in
 * **index space**: `itemIndex / items.length` of the rail. Less precise, but it
 * still answers the reader's questions — where did I type, where did it fail,
 * where is the approval waiting.
 *
 * What is shared here is the *classification*: which items earn a mark, which
 * lane a mark lives in, and who wins the colour when marks merge. The walk in
 * {@link buildMarks} mirrors `buildClusters`'s first half (the segment
 * machinery, sub-agent detection, bookmark/recap injection) minus everything
 * that needs a row model. One deliberate divergence: the terminal marks a
 * failed tool call only when it is its row's *outcome* (a fold's last member),
 * because that is what its transcript reddens; cards folds nothing
 * (`terminalBlocks` with `fold=false`), every failed top-level call reddens its
 * own card, so every one marks — the same "the rail marks what the transcript
 * reddens" rule, read against a surface with no folds.
 */

export type Lane = 'l' | 'r' | 'f'
export type MarkKind =
  | 'user'
  | 'subagent'
  | 'turn'
  | 'turnFailed'
  | 'toolFailed'
  | 'error'
  | 'approval'
  | 'recap'
  | 'bookmark'

export type Mark = {
  kind: MarkKind
  /** The jump anchor (for a turn mark: the paired response). */
  itemIndex: number
  /** The `turn_result` behind a right-lane mark — the peek shows its done-line. */
  turnIndex?: number
}

/** Members keep their own y: a dense transcript chain-merges a lane into one
 * tall bar, and the bar answers the pointer by its *nearest member* — a press
 * or peek at the middle of the bar must not act on the mark that happened to
 * found the cluster. */
export type Cluster = {
  lane: Lane
  kind: MarkKind
  y: number
  h: number
  marks: { mark: Mark; y: number }[]
}

/** The member closest to a rail-space y — what a press or peek on a merged
 * cluster resolves to. */
export function nearestMember(cluster: Cluster, y: number): Mark | undefined {
  let best: { mark: Mark; y: number } | undefined
  for (const member of cluster.marks)
    if (!best || Math.abs(member.y - y) < Math.abs(best.y - y)) best = member
  return best?.mark
}

/** The two lanes are channels, not classes: left is what went *in* (your
 * prompts, the sub-agents you dispatched), right is what came *out* (each
 * turn's answer, and everything that went wrong producing one). Full width is
 * for what is not a channel at all: the waiting approval, a bookmark, the
 * catch-up seam. See the terminal scrubber for the full argument. */
export const LANE: Record<MarkKind, Lane> = {
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

/** Who wins the colour when marks merge. */
export const LOUDNESS: Record<MarkKind, number> = {
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

export const KIND_NAME: Record<MarkKind, string> = {
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

/** The floor: an index-proportional mark has no extent to draw, so this is
 * usually the height too — 2px keeps a tick findable. */
export const MIN_MARK = 2

export const doneLine = (turn: Extract<TranscriptItem, { kind: 'turn_result' }>): string =>
  `${turn.isError ? turn.subtype : 'done'} · ${formatDuration(turn.durationMs)} · ${formatCost(turn.totalCostUsd)}`

export function excerpt(item: TranscriptItem): string {
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

/** One right-lane mark per segment, emitted when the segment closes — by the
 * next prompt, by its own turn end, or by running out of items (which is what
 * a replayed history is made of, since `#backfillHistory` carries no turn
 * rows). A `turn_result` *decorates* the answer rather than conjuring the
 * mark, so a live answer with no turn end yet is still on the rail. */
type Segment = { response?: number; turn?: number; failed?: boolean }

export interface BuildMarksOptions {
  /** The sub-agent takeover's parent id, when the rail belongs to a frame — it
   * is what "top level" means here (`undefined` at the conversation's own
   * level). Inside a frame every narration step is its own mark: the stream
   * carries no prompts and no `turn_result` for the segment machinery to work
   * with, and a fifty-step agent run is exactly where a rail earns its keep. */
  frameParentId?: string
  /** Bookmarked item indices. Paint only — the store is the client's. */
  bookmarks?: readonly number[]
  /** The catch-up boundary's item index, when the recap is spliced in. */
  recapItemIndex?: number
}

export function buildMarks(
  items: readonly TranscriptItem[],
  { frameParentId, bookmarks = [], recapItemIndex }: BuildMarksOptions = {},
): Mark[] {
  const marks: Mark[] = []
  // Which top-level calls a sub-agent ran inside — by `parentToolUseId`, never
  // by the spawning call's *name*: `Task` is the SDK's convention (a background
  // agent arrives as `Agent`), and an id other items demonstrably nest under IS
  // a sub-agent whatever spawned it.
  const subagentParents = new Set<string>()
  for (const item of items) {
    const parent = parentOf(item)
    if (parent !== undefined) subagentParents.add(parent)
  }
  let segment: Segment = {}
  const closeSegment = () => {
    const anchor = segment.response ?? segment.turn
    if (anchor !== undefined) {
      marks.push({
        kind: segment.failed ? 'turnFailed' : 'turn',
        itemIndex: anchor,
        turnIndex: segment.turn,
      })
    }
    segment = {}
  }
  items.forEach((item, index) => {
    // The dispatch itself. Deliberately not part of the chain below: a `Task`
    // whose own result errored earns a red tick in the response lane *and*
    // this mark in the input lane — one says a sub-agent ran here, the other
    // says it came back broken.
    if (item.kind === 'tool_call' && subagentParents.has(item.id)) {
      marks.push({ kind: 'subagent', itemIndex: index })
    }
    // Top-level prompts only, like the answer check below: a sub-agent's brief
    // is a `user` item too, and it would both paint a "you" mark for something
    // nobody typed and close the segment mid-turn.
    if (item.kind === 'user' && parentOf(item) === frameParentId) {
      closeSegment()
      marks.push({ kind: 'user', itemIndex: index })
    } else if (item.kind === 'turn_result') {
      segment.turn = index
      segment.failed = item.isError
      closeSegment()
    } else if (item.kind === 'notice' && item.level === 'error') {
      marks.push({ kind: 'error', itemIndex: index })
    } else if (
      // Both spellings are needed: an out-of-loop execution failure sets
      // `status` with no `is_error` block to read, and an engine can flag
      // `is_error` on a call this reducer has not settled yet. Top level only
      // — a sub-agent's failed child is represented by the sub-agent mark and
      // the Task's own red tick, exactly as the terminal rail does.
      item.kind === 'tool_call' &&
      parentOf(item) === frameParentId &&
      (item.status === 'failed' || item.result?.isError === true)
    ) {
      marks.push({ kind: 'toolFailed', itemIndex: index })
    } else if (item.kind === 'assistant_text' && parentOf(item) === frameParentId) {
      if (frameParentId !== undefined) {
        marks.push({ kind: 'turn', itemIndex: index })
        return
      }
      segment.response = index
    }
  })
  // A history that ends mid-segment still has an answer in it.
  closeSegment()
  for (const index of bookmarks)
    if (index >= 0 && index < items.length) marks.push({ kind: 'bookmark', itemIndex: index })
  if (recapItemIndex !== undefined) marks.push({ kind: 'recap', itemIndex: recapItemIndex })
  return marks
}

/**
 * Place marks proportionally — y = `itemIndex / itemCount` of the rail, every
 * mark one item's share tall (floored at {@link MIN_MARK}) — then merge
 * adjacent ones per lane, the loudest colour winning. The same merge rule as
 * the terminal rail; only the position source differs.
 */
export function clusterMarks(marks: readonly Mark[], railH: number, itemCount: number): Cluster[] {
  const count = Math.max(1, itemCount)
  const h = Math.max(MIN_MARK, Math.round(railH / count))
  const lanes = new Map<Lane, { mark: Mark; y: number }[]>()
  for (const mark of marks) {
    const y = Math.min(Math.max(0, railH - h), Math.round((mark.itemIndex / count) * railH))
    const lane = LANE[mark.kind]
    const list = lanes.get(lane) ?? []
    list.push({ mark, y })
    lanes.set(lane, list)
  }
  const clusters: Cluster[] = []
  for (const [lane, list] of lanes) {
    list.sort((a, b) => a.y - b.y)
    let current: Cluster | null = null
    for (const { mark, y } of list) {
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
  return clusters
}

/** The approval is not an item — the prompt renders below the transcript — so
 * its mark pins at the rail's foot, where the prompt is. Built by hand (no
 * item to derive a position from), hence `marks: []`. */
export function approvalCluster(railH: number): Cluster {
  return {
    lane: LANE.approval,
    kind: 'approval',
    y: Math.max(0, railH - MIN_MARK),
    h: MIN_MARK,
    marks: [],
  }
}
