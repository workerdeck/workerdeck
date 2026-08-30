import type { TranscriptItem } from '@workerdeck/react'
import { needsBlank, type TerminalBlock } from '../terminal/items.tsx'

const absorbedCache = new WeakMap<readonly TranscriptRow[], Map<number, number>>()
const positionCache = new WeakMap<readonly TranscriptRow[], Map<number, RowPosition>>()

/** One row of the virtual list: a {@link TerminalBlock}, or a synthetic row.
 * Each row carries the key its item was already React-keyed by, so a row keeps
 * its measured height when the recap splice shifts every index after it. */
export type TranscriptRow =
  | TerminalBlock
  | { key: 'recap'; line: string }
  /** The sub-agent's brief, spliced in as the takeover frame's first row. Not a
   * transcript item (the engine puts the instruction in the spawning call's
   * `prompt`), but it must be a row so the virtualizer can size and key it. */
  | { key: 'brief'; text: string }

/** The item a row is spaced *as*: a run stands for the calls it folded, a task
 * block for the `Task` call it absorbed into. */
export const rowItem = (row: TranscriptRow | undefined): TranscriptItem | undefined => {
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

/** Does a blank line go above this row, in the terminal theme? Synthetic rows
 * (no item) always earn one; otherwise the pair decides via `needsBlank`. */
export const gapBefore = (rows: TranscriptRow[], index: number): boolean => {
  const before = rowItem(rows[index - 1])
  const after = rowItem(rows[index])
  if (!before || !after) {
    return true
  }
  return needsBlank(before, after)
}

/** itemIndex → rowIndex for items a task block absorbed — the one lookup
 * {@link rowIndexForItem} cannot answer from ordering. Memoization only; the
 * answer is a pure function of the array. */
const absorbedRows = (rows: readonly TranscriptRow[]): Map<number, number> => {
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

/**
 * Transcript-item index → virtual-row index. Rows are blocks, not items, so
 * `virtualizer.scrollToIndex(itemIndex)` is wrong by construction on any folded
 * or spliced transcript — **every jump that starts from an item must come
 * through here first.**
 *
 * Absorbed indices are answered first from {@link absorbedRows}: subagents run
 * in parallel, so they interleave arbitrarily with later rows' starts and no
 * ordering argument can find their row. Everything else is the last non-recap
 * row whose start is ≤ the target; a run can fold across an absorbed gap, so
 * `[index, index + run.length)` does not describe its coverage — membership does.
 */
export const rowIndexForItem = (rows: readonly TranscriptRow[], itemIndex: number): number => {
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

/** Where an item sits inside a row it shares: its 0-based ordinal in stream
 * order, out of `count` siblings. `0 ≤ ordinal < count`. */
export type RowPosition = { ordinal: number; count: number }

const rowPositions = (rows: readonly TranscriptRow[]): Map<number, RowPosition> => {
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

/**
 * Where an item sits inside a row that holds MORE than itself. `undefined` for
 * everything else, including a row's head item and a **singleton run** — there
 * the row's extent IS the item's, and a mark spanning it is honest. That
 * carve-out is load-bearing: `pushLeaf` makes every top-level tool call a
 * `RunBlock`, usually of length 1, so without it every ordinary failed call's
 * scrubber mark would shrink to a tick.
 */
export const positionInRow = (rows: readonly TranscriptRow[], itemIndex: number): RowPosition | undefined => {
  return rowPositions(rows).get(itemIndex)
}
