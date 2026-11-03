import type { TranscriptItem } from '@workerdeck/react'
import { needsBlank, type LeafBlock, type TerminalBlock } from '../terminal/blocks.ts'

const absorbedCache = new WeakMap<readonly TranscriptRow[], Map<number, number>>()
const positionCache = new WeakMap<readonly TranscriptRow[], Map<number, RowPosition>>()

export type TranscriptRow = TerminalBlock | { key: 'recap'; line: string } | { key: 'brief'; text: string }

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameLeaf(a: LeafBlock, b: LeafBlock): boolean {
  if (a.key !== b.key || a.index !== b.index) {
    return false
  }
  if ('run' in a) {
    return 'run' in b && sameList(a.run, b.run) && sameList(a.indices, b.indices)
  }
  return 'item' in b && a.item === b.item
}

// Whether the virtualizer may keep its key callback, and so its measurements, across a rows update. It re-reads
// `estimateSize` only when the callback or the count changes, so any row whose size is still an estimate must not
// change what it draws; an estimate also reads the row before it, for its gap. Measured rows correct from the DOM.
export function keepsRowKeys(prev: readonly TranscriptRow[], next: readonly TranscriptRow[], measured: (key: string) => boolean): boolean {
  if (prev.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index++) {
    const before = prev[index]!
    const row = next[index]!
    if (before.key !== row.key) {
      return false
    }
    if (sameRow(before, row)) {
      continue
    }
    const after = next[index + 1]
    if (!measured(row.key) || (after !== undefined && !measured(after.key))) {
      return false
    }
  }
  return true
}

// Blocks are rebuilt on every pass; a row draws the same thing while its key, positions and member items are identical.
export function sameRow(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a === b) {
    return true
  }
  if ('line' in a) {
    return 'line' in b && a.line === b.line
  }
  if ('text' in a) {
    return 'text' in b && a.text === b.text
  }
  if ('task' in a) {
    return (
      'task' in b &&
      a.key === b.key &&
      a.index === b.index &&
      a.task === b.task &&
      sameList(a.childIndices, b.childIndices) &&
      a.children.length === b.children.length &&
      a.children.every((leaf, index) => sameLeaf(leaf, b.children[index]!))
    )
  }
  return !('line' in b) && !('text' in b) && !('task' in b) && sameLeaf(a, b)
}

export function rowItem(row: TranscriptRow | undefined): TranscriptItem | undefined {
  if (!row) {
    return undefined
  }
  if ('item' in row) {
    return row.item
  }
  if ('run' in row) {
    return row.run[0]
  }
  if ('task' in row) {
    return row.task
  }
  return undefined
}

export function gapBefore(rows: TranscriptRow[], index: number): boolean {
  const before = rowItem(rows[index - 1])
  const after = rowItem(rows[index])
  if (!before || !after) {
    return true
  }
  return needsBlank(before, after)
}

function absorbedRows(rows: readonly TranscriptRow[]): Map<number, number> {
  const hit = absorbedCache.get(rows)
  if (hit) {
    return hit
  }
  const map = new Map<number, number>()
  rows.forEach((row, rowIndex) => {
    if ('task' in row) {
      for (const itemIndex of row.childIndices) {
        map.set(itemIndex, rowIndex)
      }
    }
  })
  absorbedCache.set(rows, map)
  return map
}

export function rowIndexForItem(rows: readonly TranscriptRow[], itemIndex: number): number {
  const absorbed = absorbedRows(rows).get(itemIndex)
  if (absorbed !== undefined) {
    return absorbed
  }
  let lo = 0
  let hi = rows.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const row = rows[mid]!
    let start: number
    if ('index' in row) {
      start = row.index
    } else {
      const next = rows[mid + 1]
      start = next && 'index' in next ? next.index : Number.MAX_SAFE_INTEGER
    }
    if (start <= itemIndex) {
      if ('index' in row) {
        best = mid
      }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export type RowPosition = { ordinal: number; count: number }

function rowPositions(rows: readonly TranscriptRow[]): Map<number, RowPosition> {
  const hit = positionCache.get(rows)
  if (hit) {
    return hit
  }
  const map = new Map<number, RowPosition>()
  for (const row of rows) {
    if ('task' in row) {
      const count = row.childIndices.length
      row.childIndices.forEach((itemIndex, ordinal) => map.set(itemIndex, { ordinal, count }))
    } else if ('run' in row && row.run.length > 1) {
      const count = row.run.length
      row.indices.forEach((itemIndex, ordinal) => map.set(itemIndex, { ordinal, count }))
    }
  }
  positionCache.set(rows, map)
  return map
}

export function positionInRow(rows: readonly TranscriptRow[], itemIndex: number): RowPosition | undefined {
  return rowPositions(rows).get(itemIndex)
}
