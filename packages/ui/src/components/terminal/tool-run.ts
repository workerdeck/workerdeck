import { isPeerSendTool, peerDeliveredTo, type MessageOrigin } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { toolInputPreview } from '../../lib/format.ts'
import { isShellTool } from '../../lib/tool-icon.ts'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

// A message to another session draws as itself, always. Folded into a run it becomes one tick of
// `Ran 4 tools`, which is exactly the collapse that hid the conversation the reader came for.
export function isPeerSend(item: TranscriptItem): boolean {
  return item.kind === 'tool_call' && isPeerSendTool(item.name)
}

export function peerName(origin: MessageOrigin): string {
  return origin.name ?? origin.sessionId.slice(0, 8)
}

// Every peer this transcript has named, by session id. A conversation names its peers twice over: an
// arriving message carries the sender's name, a delivery receipt carries the recipient's. Either one
// answers for the other direction, so a send that was only ever acknowledged by id still draws as a
// name once the peer speaks, and a transcript recorded before the receipts carried names heals itself.
export function peerNamesOf(items: readonly TranscriptItem[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'user') {
      if (item.origin?.name) {
        names.set(item.origin.sessionId, item.origin.name)
      }
      continue
    }
    if (item.kind === 'tool_call' && isPeerSendTool(item.name) && item.result && !item.result.isError) {
      const delivered = peerDeliveredTo(item.result.text)
      if (delivered?.name) {
        names.set(delivered.sessionId, delivered.name)
      }
    }
  }
  return names
}

// Who a `peers_send` went to, read back out of the tool's own reply. Until the call settles there is
// no reply to read, so the row falls back to what the rest of the transcript knows, then to the id the
// model addressed.
export function peerSendTarget(item: ToolCallItem, names?: ReadonlyMap<string, string>): string {
  const delivered = item.result && !item.result.isError ? peerDeliveredTo(item.result.text) : undefined
  const addressed = (item.input as { sessionId?: unknown } | null)?.sessionId
  const sessionId = delivered?.sessionId ?? (typeof addressed === 'string' ? addressed : undefined)
  if (sessionId === undefined) {
    return 'peer'
  }
  return delivered?.name ?? names?.get(sessionId) ?? sessionId.slice(0, 8)
}

export function peerSendText(item: ToolCallItem): string {
  const text = (item.input as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : ''
}

export function peerOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function foldsTogether(a: ToolCallItem, b: ToolCallItem): boolean {
  if (isPeerSend(a) || isPeerSend(b)) {
    return false
  }
  return a.parentToolUseId === b.parentToolUseId
}

export function toolFamily(name: string): string {
  if (isShellTool(name)) {
    return 'shell'
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)
  if (mcp?.[1]) {
    return mcp[1].replace(/_/g, '-')
  }
  return name.toLowerCase()
}

export type RunPlan = { kind: 'call'; item: ToolCallItem } | { kind: 'summary'; items: ToolCallItem[] }

// Matches iOS's `planRun` (`TerminalPlanner.swift`): a run of exactly one call draws as the call
// itself, because the summary row would occupy the same one row while throwing away the tool's
// name, input and result preview.
export function planRun(items: ToolCallItem[]): RunPlan {
  return items.length === 1 ? { kind: 'call', item: items[0]! } : { kind: 'summary', items }
}

export function runSummary(items: readonly ToolCallItem[], busy: boolean): string {
  const verb = busy ? 'Running ' : 'Ran '
  const tail = busy ? '…' : ''
  const n = items.length

  const counts = new Map<string, number>()
  for (const item of items) {
    const family = toolFamily(item.name)
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  if (counts.size === 1 && counts.has('shell')) {
    return `${verb}${n} shell command${n === 1 ? '' : 's'}${tail}`
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family, count]) => `${count} ${family}`)
    .join(', ')
  return `${verb}${n} tool${n === 1 ? '' : 's'} · ${breakdown}${tail}`
}

function clip(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function taskLabel(task: ToolCallItem): string {
  return `${task.name}(${taskIdentity(task)})`
}

export function taskIdentity(task: ToolCallItem): string {
  const input = task.input as { description?: unknown; subagent_type?: unknown } | null
  const description = trimmed(input?.description)
  const agent = trimmed(input?.subagent_type)
  return agent && description
    ? `${agent} · ${clip(description)}`
    : (agent ?? (description ? clip(description) : toolInputPreview(task.input)))
}

export function taskBrief(task: ToolCallItem): string | undefined {
  const input = task.input as { prompt?: unknown } | null
  return trimmed(input?.prompt)
}

function callBusy(call: ToolCallItem): boolean {
  return call.status === 'running' || call.status === 'pending'
}

export function callFailed(call: ToolCallItem): boolean {
  return call.status === 'failed' || call.result?.isError === true
}

export function runFailed(items: readonly ToolCallItem[]): boolean {
  const last = items[items.length - 1]
  return last !== undefined && callFailed(last)
}

export function taskBusy(task: ToolCallItem, children: readonly TranscriptItem[]): boolean {
  return callBusy(task) || children.some((child) => child.kind === 'tool_call' && callBusy(child))
}

export function taskFailed(task: ToolCallItem): boolean {
  return callFailed(task)
}

export function taskSummary(task: ToolCallItem, children: readonly TranscriptItem[]): string {
  const busy = taskBusy(task, children)
  const calls = children.reduce((n, child) => n + (child.kind === 'tool_call' ? 1 : 0), 0)
  const label = taskLabel(task)
  if (calls === 0) {
    return busy ? `${label} · working…` : `${label} · done`
  }
  return `${label} · ${calls} tool${calls === 1 ? '' : 's'}${busy ? '…' : ''}`
}
