/**
 * What a folded run of tool calls is, and the one line that stands for it.
 * Any consecutive tool calls fold — not just shell (a shell-only membership
 * rule fragments an alternating run into per-gap counts).
 *
 * Pure and separate because `items.tsx` draws this line and `height.ts` wraps
 * these exact strings to predict the row's pixel height without a DOM — two
 * spellings would be two different heights.
 */
import type { TranscriptItem } from '@workerdeck/react'
import { toolInputPreview } from '../../lib/format.ts'
import { isShellTool } from '../../lib/tool-icon.ts'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

/**
 * What breaks a run. *Consecutive* is the rule — anything the model said
 * between two calls breaks it, and the recap boundary breaks it too (the shell
 * folds each side separately), so a count never spans "what you already read".
 * Equal `parentToolUseId` is the one membership condition: a subagent's calls
 * must not fold under a top-level count.
 */
export function foldsTogether(a: ToolCallItem, b: ToolCallItem): boolean {
  return a.parentToolUseId === b.parentToolUseId
}

/**
 * The family a tool counts as in a run's breakdown: MCP tools by their server
 * (`mcp__<server>__<tool>`), shell tools from both engines as "shell",
 * everything else its own name lowercased.
 */
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

/**
 * The run's one line. A shell-only run keeps the CLI's wording ("Ran 3 shell
 * commands"); anything mixed gets the count plus a breakdown, loudest family
 * first.
 */
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
  // Descending by count, then alphabetical — this string is the row's measured
  // height, so an unstable order would remeasure for no reason.
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family, count]) => `${count} ${family}`)
    .join(', ')
  // The ellipsis trails the whole line, not the count.
  return `${verb}${n} tool${n === 1 ? '' : 's'} · ${breakdown}${tail}`
}

/* ── The task block's one line ─────────────────────────────────────────────
 * Same contract as `runSummary`: `height.ts` wraps these exact strings, so the
 * component must render them verbatim.
 */

const clip = (text: string, max = 80): string => (text.length > max ? text.slice(0, max - 1) + '…' : text)

const trimmed = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/**
 * The row's identity half: `Task(Explore · find the auth check)`, from the
 * Task input's `subagent_type` and `description`, falling back to the ordinary
 * input preview when an engine sends neither.
 */
export function taskLabel(task: ToolCallItem): string {
  return `${task.name}(${taskIdentity(task)})`
}

/**
 * The inner half of {@link taskLabel}, without the `Task(…)` wrapper — the
 * sub-agent takeover's header. One spelling so the header, the row it opened
 * from, and protocol's `subagentLabel` cannot drift.
 */
export function taskIdentity(task: ToolCallItem): string {
  const input = task.input as { description?: unknown; subagent_type?: unknown } | null
  const description = trimmed(input?.description)
  const agent = trimmed(input?.subagent_type)
  return agent && description
    ? `${agent} · ${clip(description)}`
    : (agent ?? (description ? clip(description) : toolInputPreview(task.input)))
}

/**
 * The sub-agent's brief (the Task input's `prompt`), or undefined when the
 * engine did not give us one. This is the *fallback*, not the source: a
 * foreground `Task` forwards its brief as a nested `user_message` and the
 * frame already has it, but a **background** agent's brief never arrives in
 * the stream (measured), so callers splice this in only when the frame carries
 * no brief of its own. `description` is deliberately not a fallback — the
 * header already prints it, and it is not the instruction. Codex genuinely has
 * none (`spawn_agent` is an encrypted blob), so there the row is not drawn.
 */
export function taskBrief(task: ToolCallItem): string | undefined {
  const input = task.input as { prompt?: unknown } | null
  return trimmed(input?.prompt)
}

const callBusy = (call: ToolCallItem): boolean => call.status === 'running' || call.status === 'pending'

/** Did this one call fail? Both spellings are needed: an out-of-loop execution
 * failure sets `status` with no `is_error` block to read, and an engine can flag
 * `is_error` on a call the reducer has not settled yet. */
export const callFailed = (call: ToolCallItem): boolean => call.status === 'failed' || call.result?.isError === true

/**
 * Does a folded run colour red? **Only when its last call failed.** The last
 * call is the run's *outcome* — a failure the model recovered from mid-run is
 * normal work, and `some` would paint a healthy session red. Failures inside
 * are one press away and the recap counts them. The scrubber follows this
 * rule: it marks a failed call only when the call is its row's outcome.
 */
export function runFailed(items: readonly ToolCallItem[]): boolean {
  const last = items[items.length - 1]
  return last !== undefined && callFailed(last)
}

/** Is anything inside still going? The call itself, normally — the Task
 * settles only when its subagent finishes — but a bridged or deferred child
 * can outlive it, and a pulse that stopped while a child still worked would
 * read as a hang. */
export function taskBusy(task: ToolCallItem, children: readonly TranscriptItem[]): boolean {
  return callBusy(task) || children.some((child) => child.kind === 'tool_call' && callBusy(child))
}

/**
 * Does the row colour red? **The task's own outcome, and nothing else** — the
 * same call protocol's `SubagentInfo.status` makes. A child's recovered
 * failure must not redden the task; it is red on its own row, one press away,
 * and the recap counts it. The scrubber follows this rule too.
 */
export function taskFailed(task: ToolCallItem): boolean {
  return callFailed(task)
}

/**
 * The collapsed task row's one line: identity, then scale —
 * `Task(Explore · find the auth check) · 7 tools…`, ellipsis dropping when
 * settled. Counted from the absorbed children, never read from the engine's
 * structured Task output: a transcript replayed tomorrow must spell the same
 * line from the same items it holds today. With no tool calls yet the line
 * says `working…` (`0 tools…` reads as a stall); settled with none, `done`.
 */
export function taskSummary(task: ToolCallItem, children: readonly TranscriptItem[]): string {
  const busy = taskBusy(task, children)
  const calls = children.reduce((n, child) => n + (child.kind === 'tool_call' ? 1 : 0), 0)
  const label = taskLabel(task)
  if (calls === 0) {
    return busy ? `${label} · working…` : `${label} · done`
  }
  return `${label} · ${calls} tool${calls === 1 ? '' : 's'}${busy ? '…' : ''}`
}
