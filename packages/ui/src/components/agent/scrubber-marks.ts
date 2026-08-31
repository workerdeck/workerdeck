import type { TranscriptItem } from '@workerdeck/react'
import { formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { parentOf } from '../terminal/blocks.ts'

export type Lane = 'l' | 'r' | 'f'
export type MarkKind = 'user' | 'subagent' | 'turn' | 'turnFailed' | 'toolFailed' | 'error' | 'approval' | 'recap' | 'bookmark'

export type Mark = {
  kind: MarkKind
  itemIndex: number
  turnIndex?: number
}

export type Cluster = {
  lane: Lane
  kind: MarkKind
  y: number
  h: number
  marks: { mark: Mark; y: number }[]
}

export function nearestMember(cluster: Cluster, y: number): Mark | undefined {
  let best: { mark: Mark; y: number } | undefined
  for (const member of cluster.marks) {
    if (!best || Math.abs(member.y - y) < Math.abs(best.y - y)) {
      best = member
    }
  }
  return best?.mark
}

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

export const MIN_MARK = 2

export function doneLine(turn: Extract<TranscriptItem, { kind: 'turn_result' }>): string {
  return `${turn.isError ? turn.subtype : 'done'} · ${formatDuration(turn.durationMs)} · ${formatCost(turn.totalCostUsd)}`
}

export function excerpt(item: TranscriptItem): string {
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

type Segment = { response?: number; turn?: number; failed?: boolean }

export interface BuildMarksOptions {
  frameParentId?: string
  bookmarks?: readonly number[]
  recapItemIndex?: number
}

export function buildMarks(
  items: readonly TranscriptItem[],
  { frameParentId, bookmarks = [], recapItemIndex }: BuildMarksOptions = {},
): Mark[] {
  const marks: Mark[] = []
  const subagentParents = new Set<string>()
  for (const item of items) {
    const parent = parentOf(item)
    if (parent !== undefined) {
      subagentParents.add(parent)
    }
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
    if (item.kind === 'tool_call' && subagentParents.has(item.id)) {
      marks.push({ kind: 'subagent', itemIndex: index })
    }
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
  closeSegment()
  for (const index of bookmarks) {
    if (index >= 0 && index < items.length) {
      marks.push({ kind: 'bookmark', itemIndex: index })
    }
  }
  if (recapItemIndex !== undefined) {
    marks.push({ kind: 'recap', itemIndex: recapItemIndex })
  }
  return marks
}

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
  return clusters
}

export function approvalCluster(railH: number): Cluster {
  return {
    lane: LANE.approval,
    kind: 'approval',
    y: Math.max(0, railH - MIN_MARK),
    h: MIN_MARK,
    marks: [],
  }
}
