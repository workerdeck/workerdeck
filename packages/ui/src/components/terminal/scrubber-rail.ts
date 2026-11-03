import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { approvalCluster, buildMarks, clusterMarks, MIN_MARK, sameMarkInputs, type Cluster, type Mark, type Placement } from '../agent/scrubber-marks.ts'

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
  // Changes whenever the row keys do; the item to row mapping is fixed in between.
  rowStructure?: object
}

export function railMarks(props: Pick<RailInput, 'items' | 'bookmarks' | 'frameParentId' | 'recapRow' | 'rowIndexFor'>): Mark[] {
  const { items, bookmarks, frameParentId, recapRow, rowIndexFor } = props
  const marks: Mark[] = buildMarks(items, { frameParentId, bookmarks, rowIndexFor }).map((mark) => ({
    ...mark,
    rowIndex: rowIndexFor(mark.itemIndex),
  }))
  if (recapRow) {
    marks.push({ kind: 'recap', itemIndex: -1, rowIndex: recapRow.rowIndex })
  }
  return marks
}

export function railPlacement(props: RailInput, railH: number): Placement {
  const { rowIndexFor, offsetOfRow, sizeOfRow, positionInRow, totalSize, viewportH } = props
  const scale = railScale(railH, totalSize, viewportH)
  return (mark) => {
    const rowIndex = mark.rowIndex ?? rowIndexFor(mark.itemIndex)
    const within = mark.itemIndex >= 0 ? positionInRow?.(mark.itemIndex) : undefined
    const rowH = sizeOfRow(rowIndex)
    const h = within ? MIN_MARK : Math.max(MIN_MARK, Math.round(rowH * scale))
    const offset = offsetOfRow(rowIndex) + (within ? (within.ordinal / within.count) * rowH : 0)
    return { y: Math.min(Math.max(0, railH - h), Math.round(offset * scale)), h }
  }
}

export function placedClusters(marks: readonly Mark[], place: Placement, railH: number, approvals: boolean): Cluster[] {
  const clusters = clusterMarks(marks, place)
  if (approvals) {
    clusters.push(approvalCluster(railH))
  }
  return clusters
}

// Exported for `test/scrubber.test.ts` and the conformance goldens only, never from the package.
export function buildClusters(props: RailInput, railH: number): Cluster[] {
  return placedClusters(railMarks(props), railPlacement(props, railH), railH, props.pendingApprovals.length > 0)
}

export type RailState = {
  items: RailInput['items']
  structure: object | undefined
  bookmarks: readonly number[]
  frameParentId: string | undefined
  recap: RailInput['recapRow']
  marks: Mark[]
  railH: number
  approvals: boolean
  places: number[]
  clusters: Cluster[]
}

function placedAt(marks: readonly Mark[], places: readonly number[]): (mark: Mark) => { y: number; h: number } {
  const slot = new Map(marks.map((mark, index) => [mark, index * 2]))
  return (mark) => {
    const at = slot.get(mark)!
    return { y: places[at]!, h: places[at + 1]! }
  }
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

// The marks only change with what they read (`sameMarkInputs`), the row keys, bookmarks and the recap row; the clusters only
// with the marks' rounded placements. Both are rechecked every render, which is cheap next to rebuilding them from the
// whole transcript on every streamed event; `buildClusters` stays the reference they must agree with.
export function nextRail(previous: RailState | null, props: RailInput, railH: number): RailState {
  const recap = props.recapRow
  const marksHold =
    previous !== null &&
    props.rowStructure !== undefined &&
    previous.structure === props.rowStructure &&
    previous.frameParentId === props.frameParentId &&
    sameNumbers(previous.bookmarks, props.bookmarks) &&
    previous.recap?.rowIndex === recap?.rowIndex &&
    sameMarkInputs(previous.items, props.items)
  const marks = marksHold ? previous.marks : railMarks(props)
  const place = railPlacement(props, railH)
  const places = marks.flatMap((mark) => {
    const { y, h } = place(mark)
    return [y, h]
  })
  const approvals = props.pendingApprovals.length > 0
  const clustersHold =
    previous !== null && previous.marks === marks && previous.railH === railH && previous.approvals === approvals && sameNumbers(previous.places, places)
  const clusters = clustersHold
    ? previous.clusters
    : placedClusters(marks, placedAt(marks, places), railH, approvals)
  return {
    items: props.items,
    structure: props.rowStructure,
    bookmarks: props.bookmarks,
    frameParentId: props.frameParentId,
    recap,
    marks,
    railH,
    approvals,
    places,
    clusters,
  }
}
