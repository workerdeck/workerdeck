import type { TranscriptItem } from './transcript.ts'

export type RecapSummary = {
  turns: number
  replies: number
  tools: number
  toolNames: string[]
  files: number
  errors: number
  pending: number
  any: boolean
}

export type RecapInput = {
  items: readonly TranscriptItem[]
  pendingApprovals?: readonly unknown[]
}

// The boundary is clamped, never rejected: a transcript can shrink (a `/clear`, a compaction).
export function summarizeSince(state: RecapInput, fromIndex: number): RecapSummary {
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

export function recapLine(summary: RecapSummary): string | undefined {
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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}
