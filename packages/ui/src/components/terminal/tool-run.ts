import type { TranscriptItem } from '@workerdeck/react'
import { toolInputPreview } from '../../lib/format.ts'
import { isShellTool } from '../../lib/tool-icon.ts'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

export function foldsTogether(a: ToolCallItem, b: ToolCallItem): boolean {
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
