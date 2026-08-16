/**
 * The virtual row model: what one row of the transcript's virtual list *is*,
 * and the two rules everything positional must go through — which item a row
 * is spaced as, and how an item index maps onto a row index. Pure; shared by
 * the transcript shell and its hooks.
 */
import type { TranscriptItem } from '@workerdeck/react'
import { needsBlank, type TerminalBlock } from '../terminal/items.tsx'

/** One row of the virtual list: a {@link TerminalBlock} (a transcript item, or
 * — under the terminal theme — a folded run of tool calls), or the recap
 * boundary line spliced in at `catchUp.from`. One flat array so the virtualizer
 * sees stable indices, and each row carries the key the item was already
 * React-keyed by — measurements are cached per key, so a row keeps its measured
 * height when the recap splice shifts every index after it. */
export type TranscriptRow = TerminalBlock | { key: 'recap'; line: string }

/** The item a row is spaced *as*. A run stands for the calls it folded, so a
 * run and a lone tool call below it still read as one block. */
export function rowItem(row: TranscriptRow | undefined): TranscriptItem | undefined {
  if (!row) return undefined
  if ('item' in row) return row.item
  if ('run' in row) return row.run[0]
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
 * Transcript-item index → virtual-row index — **the off-by-a-fold trap.**
 *
 * The virtualizer's rows are {@link TerminalBlock}s, not items: a folded tool
 * run occupies ONE row for `run.length` consecutive items, and the recap
 * boundary is a row with *no* item index at all, shifting every row after it
 * by one. `virtualizer.scrollToIndex(itemIndex)` is therefore wrong by
 * construction on any folded or spliced transcript — every jump that starts
 * from an item (the scrubber's marks, a future bookmark) must come through
 * here first.
 *
 * The rule: the **last non-recap row whose first item index is ≤ the target**.
 * Rows are ordered by `index` (a run's row covers
 * `[index, index + run.length)`), so this is a binary search; the recap row
 * is skipped by giving it its successor's start for navigation (both qualify
 * at the boundary, and "last wins" lands on the real row) while never letting
 * it be the answer. Exhaustively checked against a linear reference — every
 * fixture × every item index × several splice positions — by
 * `__wdCheckMapping` in `dev/App.tsx`.
 */
export function rowIndexForItem(rows: readonly TranscriptRow[], itemIndex: number): number {
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
