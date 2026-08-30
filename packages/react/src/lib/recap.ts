import type { TranscriptItem } from './transcript.ts'

/**
 * "What happened while you were away", counted rather than written: a prose
 * recap would spend a turn on a summary nobody asked for, and would be wrong in
 * the case that matters most — a session that failed unattended, where the
 * model is exactly who you shouldn't ask. Framework-free and pure, like the
 * reducer it reads from: both clients render the same recap from the same
 * numbers.
 */
export type RecapSummary = {
  /** Completed turns — `turn_result` rows, the engine's own unit of work. */
  turns: number
  /** Messages the model wrote. Streaming ones count: they are on screen. */
  replies: number
  /** Tool calls started, and the distinct names, most-used first. */
  tools: number
  toolNames: string[]
  /** Files the agent handed over (`file_delivered`). */
  files: number
  /** Failed turns and failed tool calls, together — what you'd want to know
   * first on coming back. */
  errors: number
  /** Approvals still waiting. Not a count of what happened, but the reason to
   * look now rather than later. */
  pending: number
  /** Any of the above non-zero. A recap of nothing is noise. */
  any: boolean
}

/** The `TranscriptState` fields a recap reads — structural, so a caller can
 * pass the whole state or just these. */
export type RecapInput = {
  items: readonly TranscriptItem[]
  pendingApprovals?: readonly unknown[]
}

/**
 * Summarize the items from `fromIndex` onward — the boundary being the number
 * of items that existed when the session was last looked at.
 *
 * An out-of-range boundary is clamped rather than rejected: a transcript can
 * *shrink* (a `/clear`, a fresh attach after a compaction), and the honest
 * reading of "you last saw 40 items, there are now 12" is "everything here is
 * new", not a negative count.
 */
export const summarizeSince = (state: RecapInput, fromIndex: number): RecapSummary => {
  const start = Math.max(0, Math.min(fromIndex, state.items.length))
  const fresh = state.items.slice(start)
  const toolCounts = new Map<string, number>()
  let turns = 0
  let replies = 0
  let tools = 0
  let files = 0
  let errors = 0

  for (const item of fresh) {
    switch (item.kind) {
      case 'turn_result': {
        turns += 1
        if (item.isError) {
          errors += 1
        }
        break
      }
      case 'assistant_text': {
        replies += 1
        break
      }
      case 'tool_call': {
        tools += 1
        toolCounts.set(item.name, (toolCounts.get(item.name) ?? 0) + 1)
        if (item.status === 'failed' || item.result?.isError) {
          errors += 1
        }
        break
      }
      case 'file_delivered': {
        files += 1
        break
      }
      case 'notice': {
        if (item.level === 'error') {
          errors += 1
        }
        break
      }
      default: {
        break
      }
    }
  }

  const toolNames = [...toolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name)
  const pending = state.pendingApprovals?.length ?? 0
  return {
    turns,
    replies,
    tools,
    toolNames,
    files,
    errors,
    pending,
    any: turns + replies + tools + files + errors + pending > 0,
  }
}

/**
 * The recap as one line of text, in the order a person reads it: what got done,
 * what it used, what went wrong, what is waiting.
 *
 * Returns `undefined` when there is nothing to say, so a caller can render the
 * row or not on the value alone.
 */
export const recapLine = (summary: RecapSummary): string | undefined => {
  if (!summary.any) {
    return undefined
  }
  const parts: string[] = []
  if (summary.turns > 0) {
    parts.push(plural(summary.turns, 'turn'))
  } else if (summary.replies > 0) {
    parts.push(plural(summary.replies, 'reply', 'replies'))
  }
  if (summary.tools > 0) {
    // Three names is enough to recognise what it was doing; beyond that the
    // count carries more than the list.
    const named = summary.toolNames.slice(0, 3).join(', ')
    const rest = summary.toolNames.length - 3
    parts.push(`${plural(summary.tools, 'tool call')}${named ? ` (${named}${rest > 0 ? `, +${rest}` : ''})` : ''}`)
  }
  if (summary.files > 0) {
    parts.push(plural(summary.files, 'file'))
  }
  if (summary.errors > 0) {
    parts.push(plural(summary.errors, 'error'))
  }
  if (summary.pending > 0) {
    parts.push(`${plural(summary.pending, 'approval')} waiting`)
  }
  return parts.join(' · ')
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
