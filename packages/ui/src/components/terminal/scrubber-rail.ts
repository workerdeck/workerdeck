import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { approvalCluster, buildMarks, clusterMarks, MIN_MARK, type Cluster, type Mark } from '../agent/scrubber-marks.ts'

// The rail's pure half, apart from the component so `conformance/` can load it under plain node.

export function railScale(railH: number, totalSize: number, viewportH: number): number {
  return totalSize > 0 ? railH / Math.max(totalSize, viewportH) : 0
}

export interface RailInput {
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
  viewportH: number
}

// Exported for `test/scrubber.test.ts` and the conformance goldens only, never from the package.
export function buildClusters(props: RailInput, railH: number): Cluster[] {
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
