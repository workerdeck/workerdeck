/**
 * The terminal theme's block model — **which rows exist**.
 *
 * Pure and separate from `items.tsx` because which rows exist is part of what
 * the theme *is*: the virtualizer counts these, `height.ts` sizes them, the
 * scrubber addresses them, and both renderers — the virtualized shell in
 * `agent/Transcript.tsx` and the plain `TerminalTranscript` — must fold
 * identically or two clients would be showing different transcripts of the
 * same session. `items.tsx` re-exports everything here, so its old imports
 * keep working; the components stay there, the model lives here.
 *
 * Two folds happen in one pass:
 *
 * - **Runs.** Consecutive tool calls fold into one row (`tool-run.ts` owns the
 *   membership rule and the summary line).
 * - **Tasks.** A `Task` tool call *absorbs* every item whose
 *   `parentToolUseId` names it — its subagent's brief, thinking, text and
 *   tool calls — into ONE row, **wherever those items fall in the stream**.
 *   Subagents run in parallel, so their items interleave with each other and
 *   with top-level work; a consecutive-run rule cannot group them, which is
 *   why absorption is by parent id and not by adjacency. The absorbed items
 *   are folded again *within* the block (a subagent's consecutive calls
 *   become runs — `foldsTogether` already keys on `parentToolUseId`), and the
 *   block is always collapsed by default: that preserves the height
 *   calculator's invariant that an unmounted row is collapsed by definition.
 *
 * The absorption rule, precisely: a task block forms for a **top-level** tool
 * call (`parentToolUseId` empty) that has at least one child in the slice,
 * and an item is absorbed iff its parent is such a call. Everything else
 * renders as its own row, which settles the edges deliberately:
 *
 * - A **childless** `Task` call is a plain tool call and folds into runs —
 *   right for a task still spawning, and for a resumed session whose
 *   children were compacted away entirely.
 * - An **orphan** child (its parent call absent from the slice) keeps today's
 *   behaviour: its own row, stepped in behind a rule. The recap boundary is
 *   the load-bearing case — the shell folds each side separately, so a task
 *   split by the boundary shows its post-boundary children *below* the seam
 *   rather than hiding new work inside a collapsed row above it, the same
 *   claim the run fold makes about never counting across "what you already
 *   read".
 * - A **grandchild** (parent is itself a subagent's call — unreachable from
 *   today's engines, which do not nest sidechains) is not absorbed and not
 *   dropped: it renders top-level, stepped in. An unmapped item must be
 *   visible, never gone.
 * - Two top-level calls separated only by absorbed items **fold together**:
 *   the interleaved step was another frame's work, and once it is absorbed
 *   the two calls are adjacent on screen — the count matches what the reader
 *   sees.
 */
import type { TranscriptItem } from '@workerdeck/react'
import { foldsTogether } from './tool-run.ts'

export type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

/**
 * The id of the tool call this item was produced inside, or `undefined` at the
 * top level. One spelling for both shapes the reducer emits: `assistant_text`
 * / `thinking` / `tool_call` carry `parentToolUseId: string | null` on every
 * instance, while `user` carries it **optionally** (a human prompt has no
 * parent at all — the key exists only on a subagent's brief). Callers must go
 * through this rather than reading the field, or the absent-key case silently
 * types as a compile error on one kind and a miss on another.
 */
export function parentOf(item: TranscriptItem): string | undefined {
  const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined
  return parent ?? undefined
}

/** Is this a row the transcript folds into a run? Any tool call is — see
 * `tool-run.ts` for why this is no longer shell-only. */
export function isRunCall(item: TranscriptItem): item is ToolCallItem {
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
  /** Every member's global transcript index, in stream order — `childIndices`'
   * sibling, and needed for the same reason: a run folded across an absorbed
   * gap has no `[index, index + len)` coverage, so a member's ordinal within
   * the run (what the scrubber anchors a failure by) is unrecoverable from
   * `index` arithmetic. */
  indices: number[]
  index: number
}
/** What a task block's children fold into. Never a task block itself — the
 * engines do not nest sidechains, and a hypothetical grandchild renders
 * top-level rather than vanishing (see the module comment). */
export type LeafBlock = ItemBlock | RunBlock

/**
 * A `Task` call and everything produced inside it, as ONE row — collapsed by
 * default, pressable to expand, the same shape as the folded tool run.
 *
 * - `task` is the call itself; `index` its own transcript index, which is the
 *   row's address (rows stay ordered by `index`).
 * - `children` are the absorbed items in stream order, folded exactly as
 *   top-level rows are; each leaf's `index` is its first member's *global*
 *   transcript index.
 * - `childIndices` is the flat list of every absorbed item's global index, in
 *   stream order. It exists because absorption is the one exception to row
 *   contiguity: a child run's members can straddle other rows' starts, so no
 *   `[start, start + len)` arithmetic can say what this row covers —
 *   `rowIndexForItem` answers from this list instead.
 */
export type TaskBlock = {
  key: string
  task: ToolCallItem
  children: LeafBlock[]
  childIndices: number[]
  index: number
}

/**
 * Fold consecutive tool calls into runs and absorb subagent items into task
 * blocks, leaving everything else alone.
 */
export type TerminalBlock = ItemBlock | RunBlock | TaskBlock

/** The absorbed items, flat and in stream order — what `taskSummary` counts
 * and the collapsed row's one line is built from. */
export function taskChildItems(block: TaskBlock): TranscriptItem[] {
  return block.children.flatMap((child) => ('run' in child ? child.run : [child.item]))
}

/** Append one item to a leaf-block list, folding it into the previous run when
 * the membership rule allows — the one fold implementation, used for the
 * top-level stream and for each task's children alike. */
function pushLeaf(out: LeafBlock[], item: TranscriptItem, index: number): void {
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
export function terminalBlocks(
  items: readonly TranscriptItem[],
  offset = 0,
  fold = true,
): TerminalBlock[] {
  if (!fold) {
    return items.map((item, position) => ({
      key: `${item.kind}:${item.id}`,
      item,
      index: offset + position,
    }))
  }

  // Which top-level tool calls have children in this slice, and what those
  // children are. Collected over the whole slice before any block is built:
  // membership is by parent id, not adjacency, so a call cannot know it is a
  // task until every item has been seen.
  const topLevelCalls = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tool_call' && parentOf(item) === undefined) topLevelCalls.add(item.id)
  }
  const childrenOf = new Map<string, { item: TranscriptItem; index: number }[]>()
  items.forEach((item, position) => {
    const parent = parentOf(item)
    if (parent !== undefined && topLevelCalls.has(parent)) {
      const list = childrenOf.get(parent)
      if (list) list.push({ item, index: offset + position })
      else childrenOf.set(parent, [{ item, index: offset + position }])
    }
  })

  const out: TerminalBlock[] = []
  for (const [position, item] of items.entries()) {
    const index = offset + position
    const parent = parentOf(item)
    // Absorbed into its task's row — it must not also appear as its own.
    if (parent !== undefined && childrenOf.has(parent)) continue
    if (item.kind === 'tool_call') {
      const children = childrenOf.get(item.id)
      if (children) {
        const folded: LeafBlock[] = []
        for (const child of children) pushLeaf(folded, child.item, child.index)
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
export function needsBlank(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (previous.kind === 'tool_call' && next.kind === 'tool_call') return false
  return true
}

/** The same rule over blocks: a run counts as the tool calls it folded, and a
 * task block counts as the `Task` call it stands for — a collapsed task row
 * sits flush with the tool rows of the same turn, exactly as the call itself
 * did before it grew children. */
export function blockNeedsBlank(previous: TerminalBlock, next: TerminalBlock): boolean {
  const kind = (block: TerminalBlock) => ('item' in block ? block.item.kind : 'tool_call')
  return !(kind(previous) === 'tool_call' && kind(next) === 'tool_call')
}
