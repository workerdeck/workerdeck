/**
 * The virtual row model: what one row of the transcript's virtual list *is*,
 * and the two rules everything positional must go through — which item a row
 * is spaced as, and how an item index maps onto a row index. Pure; shared by
 * the transcript shell and its hooks.
 */
import type { TranscriptItem } from '@workerdeck/react'
import { needsBlank, type TerminalBlock } from '../terminal/items.tsx'

/** One row of the virtual list: a {@link TerminalBlock} (a transcript item,
 * — under the terminal theme — a folded run of tool calls, or a task block
 * standing for a `Task` call and everything its subagent produced), or the
 * recap boundary line spliced in at `catchUp.from`. One flat array so the
 * virtualizer sees stable indices, and each row carries the key the item was
 * already React-keyed by — measurements are cached per key, so a row keeps its
 * measured height when the recap splice shifts every index after it. */
export type TranscriptRow = TerminalBlock | { key: 'recap'; line: string }

/** The item a row is spaced *as*. A run stands for the calls it folded, and a
 * task block for the `Task` call it absorbed into — all tool calls, so a run,
 * a task and a lone tool call below them still read as one block. */
export function rowItem(row: TranscriptRow | undefined): TranscriptItem | undefined {
  if (!row) return undefined
  if ('item' in row) return row.item
  if ('run' in row) return row.run[0]
  if ('task' in row) return row.task
  return undefined
}

/**
 * Does a blank line go above this row, in the terminal theme?
 *
 * The recap row always earns one — it is a boundary, and a boundary flush
 * against the row above reads as part of it. Otherwise the pair decides
 * (`needsBlank`): consecutive tool calls are one block in the CLI and get none.
 */
export function gapBefore(rows: TranscriptRow[], index: number): boolean {
  const before = rowItem(rows[index - 1])
  const after = rowItem(rows[index])
  if (!before || !after) return true
  return needsBlank(before, after)
}

/**
 * Which items each task block absorbed, as itemIndex → rowIndex — the one
 * lookup {@link rowIndexForItem} cannot answer from ordering (see its comment).
 * Memoized per rows array identity: the shell builds `rows` in a `useMemo`, so
 * within one row list this is built once, and a WeakMap means a discarded list
 * takes its map with it. Memoization only — the answer is a pure function of
 * the array.
 */
const absorbedCache = new WeakMap<readonly TranscriptRow[], Map<number, number>>()

function absorbedRows(rows: readonly TranscriptRow[]): Map<number, number> {
  const hit = absorbedCache.get(rows)
  if (hit) return hit
  const map = new Map<number, number>()
  rows.forEach((row, rowIndex) => {
    if ('task' in row) for (const itemIndex of row.childIndices) map.set(itemIndex, rowIndex)
  })
  absorbedCache.set(rows, map)
  return map
}

/**
 * Transcript-item index → virtual-row index — **the off-by-a-fold trap.**
 *
 * The virtualizer's rows are {@link TerminalBlock}s, not items: a folded tool
 * run occupies ONE row for `run.length` consecutive items, a task block
 * occupies ONE row for its `Task` call *plus every item its subagent produced*,
 * and the recap boundary is a row with *no* item index at all, shifting every
 * row after it by one. `virtualizer.scrollToIndex(itemIndex)` is therefore
 * wrong by construction on any folded or spliced transcript — every jump that
 * starts from an item (the scrubber's marks, a future bookmark) must come
 * through here first.
 *
 * The contract, in two halves:
 *
 * - An index a task block **absorbed** maps to that block's row, wherever the
 *   child fell in the stream. Subagents run in parallel, so absorbed indices
 *   interleave arbitrarily with later rows' starts — no ordering argument can
 *   find their row, which is why they are answered first, from a per-row-list
 *   map ({@link absorbedRows}) built once per rows array. A row's coverage is
 *   its `childIndices`, never `[index, index + N)` arithmetic.
 * - Every other index maps to the **last non-recap row whose start (`index`)
 *   is ≤ the target** — the original rule, still a binary search. Rows stay
 *   ordered by `index`, and the ordering argument is now: between one row's
 *   start and the next row's, every index is either absorbed (answered above)
 *   or a member of the earlier row — note that is *weaker* than the old
 *   contiguity claim, because a run can fold across an absorbed gap (two
 *   top-level calls separated only by a subagent's step are adjacent on
 *   screen), so `[index, index + run.length)` arithmetic no longer describes
 *   a run's coverage; membership does. The recap row is skipped by giving it
 *   its successor's start for navigation (both qualify at the boundary, and
 *   "last wins" lands on the real row) while never letting it be the answer.
 *
 * Exhaustively checked against a linear reference — every fixture × every item
 * index × several splice positions — by `__wdCheckMapping` in `dev/App.tsx`,
 * and against constructed interleavings in `test/transcript-rows.test.ts`.
 */
export function rowIndexForItem(rows: readonly TranscriptRow[], itemIndex: number): number {
  const absorbed = absorbedRows(rows).get(itemIndex)
  if (absorbed !== undefined) return absorbed
  let lo = 0
  let hi = rows.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const row = rows[mid]!
    let start: number
    if ('index' in row) start = row.index
    else {
      const next = rows[mid + 1]
      start = next && 'index' in next ? next.index : Number.MAX_SAFE_INTEGER
    }
    if (start <= itemIndex) {
      if ('index' in row) best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}
