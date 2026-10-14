import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'

import { parentOf, subagentItems, terminalBlocks, type ToolCallItem } from '../packages/ui/src/components/terminal/blocks.ts'
import { buildClusters } from '../packages/ui/src/components/terminal/scrubber-rail.ts'
import { taskBrief } from '../packages/ui/src/components/terminal/tool-run.ts'
import { positionInRow, rowIndexForItem, type TranscriptRow } from '../packages/ui/src/components/agent/transcript-rows.ts'

// The rail over synthetic row heights: the planner's heights have their own goldens, so these pin only marks,
// row mapping, placement and clustering. Mirrors `Transcript.tsx`'s rows and `TranscriptRows.tsx`'s wiring.

const LINE = 44

type Variant = {
  name: string
  items: TranscriptItem[]
  frameParentId: string | null
  frameTask?: ToolCallItem
  recapAt: number | null
  bookmarks: string[]
  pending: number
  railH: number
  viewportH: number
}

function rowsOf(variant: Variant): TranscriptRow[] {
  const { items, recapAt, frameTask } = variant
  const fold = (from: number, to: number) => terminalBlocks(items.slice(from, to), from, true)
  const brief = frameTask && !items.some((item) => item.kind === 'user') ? taskBrief(frameTask) : undefined
  const lead: TranscriptRow[] = brief ? [{ key: 'brief', text: brief }] : []
  if (recapAt === null) {
    return [...lead, ...fold(0, items.length)]
  }
  return [...fold(0, recapAt), { key: 'recap', line: 'recap' }, ...fold(recapAt, items.length)]
}

function render(variant: Variant) {
  const rows = rowsOf(variant)
  const heights = rows.map((_, index) => LINE * (1 + ((index * 7 + 3) % 5)))
  const offsets = heights.reduce<number[]>((acc, height) => [...acc, acc.at(-1)! + height], [0])
  const indexById = new Map(variant.items.map((item, index) => [item.id, index]))
  const recapIndex = rows.findIndex((row) => row.key === 'recap')
  const pendingApprovals = Array.from(
    { length: variant.pending },
    (_, index) => ({ id: `p${index}`, toolName: 'Bash', input: { command: 'ls' } }) as unknown as PermissionRequest,
  )
  const clusters = buildClusters(
    {
      items: variant.items,
      pendingApprovals,
      recapRow: recapIndex >= 0 ? { rowIndex: recapIndex, label: 'recap' } : undefined,
      bookmarks: variant.bookmarks.map((id) => indexById.get(id)).filter((index): index is number => index !== undefined),
      frameParentId: variant.frameParentId ?? undefined,
      rowIndexFor: (itemIndex) => rowIndexForItem(rows, itemIndex),
      positionInRow: (itemIndex) => positionInRow(rows, itemIndex),
      offsetOfRow: (rowIndex) => offsets[rowIndex] ?? 0,
      sizeOfRow: (rowIndex) => heights[rowIndex] ?? 0,
      totalSize: offsets.at(-1)!,
      viewportH: variant.viewportH,
    },
    variant.railH,
  )
  return {
    name: variant.name,
    frameParentId: variant.frameParentId,
    recapAt: variant.recapAt,
    bookmarks: variant.bookmarks,
    pending: variant.pending,
    railH: variant.railH,
    viewportH: variant.viewportH,
    heights,
    clusters: clusters.map((cluster) => ({
      lane: cluster.lane,
      kind: cluster.kind,
      y: cluster.y,
      h: cluster.h,
      marks: cluster.marks.map(({ mark, y }) => ({
        kind: mark.kind,
        itemIndex: mark.itemIndex < 0 ? null : mark.itemIndex,
        rowIndex: mark.rowIndex ?? rowIndexForItem(rows, mark.itemIndex),
        turnIndex: mark.turnIndex ?? null,
        y,
      })),
    })),
  }
}

export function scrubberGolden(items: readonly TranscriptItem[]): unknown[] {
  const all = [...items]
  const bookmarks = [...all.filter((_, index) => index % 3 === 1).map((item) => item.id), 'not-in-this-transcript']
  const variants: Variant[] = [
    { name: 'top', items: all, frameParentId: null, recapAt: null, bookmarks: [], pending: 0, railH: 600, viewportH: 900 },
    {
      name: 'dense',
      items: all,
      frameParentId: null,
      recapAt: all.length >= 4 ? Math.floor(all.length / 2) : null,
      bookmarks,
      pending: 1,
      railH: 120,
      viewportH: 400,
    },
  ]
  const parents = new Set(all.map(parentOf).filter((parent): parent is string => parent !== undefined))
  for (const task of all) {
    if (task.kind === 'tool_call' && parents.has(task.id)) {
      variants.push({
        name: `frame:${task.id}`,
        items: subagentItems(all, task.id),
        frameParentId: task.id,
        frameTask: task,
        recapAt: null,
        bookmarks: [],
        pending: 0,
        railH: 300,
        viewportH: 500,
      })
    }
  }
  return variants.map(render)
}
