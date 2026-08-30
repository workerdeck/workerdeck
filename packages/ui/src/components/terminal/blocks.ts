/**
 * The terminal theme's block model — **which rows exist**. Pure and separate
 * from `items.tsx` because the virtualizer counts these, `height.ts` sizes
 * them, the scrubber addresses them, and both renderers (the virtualized shell
 * and the plain `TerminalTranscript`) must fold identically.
 *
 * Two folds in one pass: consecutive tool calls into **runs** (`tool-run.ts`
 * owns membership and wording), and a `Task` call **absorbing** every item
 * whose `parentToolUseId` names it into ONE row — by parent id, not adjacency,
 * because parallel subagents interleave. Absorbed items are folded again
 * within the block, and the block is always collapsed by default (an unmounted
 * row is collapsed by definition — `height.ts`'s invariant).
 *
 * The absorption rule, precisely: a task block forms for a **top-level** call
 * with at least one child in the slice; an item is absorbed iff its parent is
 * such a call. The deliberate edges:
 *
 * - A **childless** `Task` call is a plain tool call and folds into runs.
 * - An **orphan** child (parent absent from the slice) renders as its own row.
 *   Load-bearing at the recap boundary: the shell folds each side separately,
 *   so a task split by the boundary shows post-boundary children *below* the
 *   seam rather than hiding new work in a collapsed row above it.
 * - A **grandchild** (nested sidechain — unreachable today) renders top-level,
 *   stepped in: an unmapped item must be visible, never gone.
 * - Two top-level calls separated only by absorbed items **fold together** —
 *   once absorbed, the calls are adjacent on screen and the count matches what
 *   the reader sees.
 */
import type { TranscriptItem } from '@workerdeck/react'
import { foldsTogether } from './tool-run.ts'

export type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

/**
 * The id of the tool call this item was produced inside, or `undefined` at the
 * top level. Callers must go through this rather than reading the field:
 * `user` items carry `parentToolUseId` only optionally (the key exists only on
 * a subagent's brief), the other kinds carry it as `string | null`.
 */
export const parentOf = (item: TranscriptItem): string | undefined => {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  return parent ?? undefined
}

/**
 * **The frame membership rule**: the items a sub-agent produced, and nothing
 * else — what the takeover renders. One exported function because iOS mirrors
 * the terminal model out of this module. Excludes the spawning `Task` call
 * itself (the frame, not a row in it). Safe to hand straight to
 * {@link terminalBlocks} at offset 0: nothing in the slice is top-level, so
 * nothing absorbs, and runs still fold because {@link foldsTogether} keys on
 * an *equal* parent rather than absence of one.
 */
export const subagentItems = (items: readonly TranscriptItem[], parentToolUseId: string): TranscriptItem[] => {
  return items.filter((item) => parentOf(item) === parentToolUseId)
}

/** Is this a row the transcript folds into a run? Any tool call is — see
 * `tool-run.ts` for why this is no longer shell-only. */
export const isRunCall = (item: TranscriptItem): item is ToolCallItem => {
  return item.kind === 'tool_call'
}

/** One transcript item as its own row. */
export type ItemBlock = { key: string; item: TranscriptItem; index: number }
/** A folded run of consecutive tool calls — one row for `run.length` items.
 * At the top level its coverage is contiguous (`[index, index + run.length)`);
 * inside a task block the members' global indices may be scattered (the run is
 * consecutive in the *subagent's* stream, not the transcript's). */
export type RunBlock = {
  key: string
  run: ToolCallItem[]
  /** Every member's global transcript index, in stream order. Load-bearing: a
   * run folded across an absorbed gap has no `[index, index + len)` coverage,
   * so a member's ordinal (what the scrubber anchors a failure by) is
   * unrecoverable from `index` arithmetic. */
  indices: number[]
  index: number
}
/** What a task block's children fold into. Never a task block itself — the
 * engines do not nest sidechains, and a hypothetical grandchild renders
 * top-level rather than vanishing (see the module comment). */
export type LeafBlock = ItemBlock | RunBlock

/**
 * A `Task` call and everything produced inside it, as ONE row. `children` are
 * the absorbed items in stream order, folded exactly as top-level rows are.
 * `childIndices` exists because absorption is the one exception to row
 * contiguity: no `[start, start + len)` arithmetic can say what this row
 * covers, so `rowIndexForItem` answers from this list.
 */
export type TaskBlock = {
  key: string
  task: ToolCallItem
  children: LeafBlock[]
  childIndices: number[]
  index: number
}

export type TerminalBlock = ItemBlock | RunBlock | TaskBlock

/** The absorbed items, flat and in stream order — what `taskSummary` counts
 * and the collapsed row's one line is built from. */
export const taskChildItems = (block: TaskBlock): TranscriptItem[] => {
  return block.children.flatMap((child) => ('run' in child ? child.run : [child.item]))
}

/** The one fold implementation, used for the top-level stream and for each
 * task's children alike. */
const pushLeaf = (out: LeafBlock[], item: TranscriptItem, index: number): void => {
  const previous = out.at(-1)
  if (isRunCall(item)) {
    if (previous && 'run' in previous && foldsTogether(previous.run[0]!, item)) {
      previous.run.push(item)
      previous.indices.push(index)
    } else {
      // Keyed by the run's *first* call, so the key is stable as the run grows.
      out.push({ key: `run:${item.id}`, run: [item], indices: [index], index })
    }
    return
  }
  out.push({ key: `${item.kind}:${item.id}`, item, index })
}

/**
 * @param offset  What `items[0]`'s index is in the whole transcript — the
 *   virtualized shell folds each side of the recap boundary separately, and the
 *   rows still have to say where they sit for the catch-up dimming.
 * @param fold    Whether to group at all. `false` gives one block per item —
 *   no runs *and no task absorption* — which is what the cards variant
 *   renders: this is the terminal theme's rule and must not silently reshape
 *   another renderer's row list.
 */
export const terminalBlocks = (items: readonly TranscriptItem[], offset = 0, fold = true): TerminalBlock[] => {
  if (!fold) {
    return items.map((item, position) => ({
      key: `${item.kind}:${item.id}`,
      item,
      index: offset + position,
    }))
  }

  // Collected over the whole slice before any block is built: membership is by
  // parent id, not adjacency, so a call cannot know it is a task until every
  // item has been seen.
  const topLevelCalls = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tool_call' && parentOf(item) === undefined) {
      topLevelCalls.add(item.id)
    }
  }
  const childrenOf = new Map<string, { item: TranscriptItem; index: number }[]>()
  items.forEach((item, position) => {
    const parent = parentOf(item)
    if (parent !== undefined && topLevelCalls.has(parent)) {
      const list = childrenOf.get(parent)
      if (list) {
        list.push({ item, index: offset + position })
      } else {
        childrenOf.set(parent, [{ item, index: offset + position }])
      }
    }
  })

  const out: TerminalBlock[] = []
  for (const [position, item] of items.entries()) {
    const index = offset + position
    const parent = parentOf(item)
    // Absorbed into its task's row — it must not also appear as its own.
    if (parent !== undefined && childrenOf.has(parent)) {
      continue
    }
    if (item.kind === 'tool_call') {
      const children = childrenOf.get(item.id)
      if (children) {
        const folded: LeafBlock[] = []
        for (const child of children) {
          pushLeaf(folded, child.item, child.index)
        }
        out.push({
          key: `task:${item.id}`,
          task: item,
          children: folded,
          childIndices: children.map((child) => child.index),
          index,
        })
        continue
      }
    }
    pushLeaf(out as LeafBlock[], item, index)
  }
  return out
}

/** Spacing between two items: a blank line, unless the pair belongs together.
 * Tool output already sits under its call, and a run of tool calls reads as one
 * block — the CLI leaves no blank line inside either. */
export const needsBlank = (previous: TranscriptItem, next: TranscriptItem): boolean => {
  if (previous.kind === 'tool_call' && next.kind === 'tool_call') {
    return false
  }
  return true
}

/** The same rule over blocks: a run counts as the tool calls it folded, and a
 * task block counts as the `Task` call it stands for — a collapsed task row
 * sits flush with the tool rows of the same turn, exactly as the call itself
 * did before it grew children. */
export const blockNeedsBlank = (previous: TerminalBlock, next: TerminalBlock): boolean => {
  const kind = (block: TerminalBlock) => ('item' in block ? block.item.kind : 'tool_call')
  return !(kind(previous) === 'tool_call' && kind(next) === 'tool_call')
}
