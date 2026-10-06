import { formatDuration } from '../../lib/format.ts'
import type { TranscriptItem } from '@workerdeck/react'
import type { ToolCallItem } from './blocks.ts'

export const LIVE_TAIL_LINES = 5
export const ELAPSED_AFTER_MS = 5000
export const SEND_NOW_AFTER_MS = 5000
// The widest label the header grows by while busy, so a height estimate never undercounts a wrap.
export const ELAPSED_WIDEST = ' ·\u00a059m\u00a059s'

const BACKGROUNDABLE = new Set(['Bash', 'Task', 'Agent'])

export function toolBusy(item: ToolCallItem): boolean {
  const status = item.status ?? (item.result === undefined ? 'running' : 'settled')
  return status === 'running' || status === 'pending'
}

export function liveTailLines(item: ToolCallItem): string[] {
  if (!item.liveTail || !toolBusy(item)) {
    return []
  }
  return item.liveTail.split('\n').slice(-LIVE_TAIL_LINES)
}

export function elapsedLabel(startedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined || now - startedAt < ELAPSED_AFTER_MS) {
    return undefined
  }
  return formatDuration(Math.floor((now - startedAt) / 1000) * 1000).replace(' ', '\u00a0')
}

export function runStartedAt(items: readonly ToolCallItem[]): number | undefined {
  let earliest: number | undefined
  for (const item of items) {
    if (toolBusy(item) && item.ts !== undefined && (earliest === undefined || item.ts < earliest)) {
      earliest = item.ts
    }
  }
  return earliest
}

export function canBackground(item: ToolCallItem): boolean {
  return BACKGROUNDABLE.has(item.name) && item.parentToolUseId == null && toolBusy(item)
}

export function runTailLines(items: readonly ToolCallItem[]): string[] {
  for (let index = items.length - 1; index >= 0; index--) {
    const lines = liveTailLines(items[index]!)
    if (lines.length > 0) {
      return lines
    }
  }
  return []
}

// Walks back only through the current turn: a running call is never older than the last prompt.
// The earliest start among them, or 0 when a call carries no `ts`.
export function backgroundableSince(items: readonly TranscriptItem[]): number | undefined {
  let since: number | undefined
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.kind === 'user' && item.parentToolUseId == null) {
      break
    }
    if (item.kind === 'tool_call' && canBackground(item)) {
      const ts = item.ts ?? 0
      since = since === undefined ? ts : Math.min(since, ts)
    }
  }
  return since
}
