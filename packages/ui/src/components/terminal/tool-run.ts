/**
 * What a folded run of tool calls is, and the one line that stands for it.
 *
 * The fold was shell-only, and the screenshot that started this made the cost
 * obvious: a run of six calls that happened to alternate `Bash` with an MCP tool
 * folded into *four* rows reading "Ran 1 shell command", "Ran 2 shell commands",
 * "Ran 1 shell command" — a count for every gap between the calls it could not
 * group. The grouping rule was right and the *membership* rule was too narrow.
 *
 * So any consecutive tool calls fold. The CLI's own line is the target
 * (`called roam-code, ran 1 shell command`), and the claim is unchanged from the
 * shell version: a tool call is almost never what you came back to read, and six
 * of them bury the sentence that is.
 *
 * Pure and separate because `items.tsx` draws this line and `height.ts` wraps it
 * to predict the row's pixel height without a DOM — the same reason
 * `result-preview.ts` exists. Two spellings would be two different heights.
 */
import type { TranscriptItem } from '@workerdeck/react'
import { toolInputPreview } from '../../lib/format.ts'
import { isShellTool } from '../../lib/tool-icon.ts'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

/**
 * What breaks a run.
 *
 * *Consecutive* is still the whole rule, and it is the reason the fold is honest:
 * anything the model said between two calls breaks the run, because that
 * sentence is the reason the second one happened and a count spanning it would
 * claim the two were one act. The recap boundary breaks it too — the virtualized
 * shell folds each side separately — so a count never spans "what you already
 * read".
 *
 * `parentToolUseId` is the one addition the wider membership rule needs: a
 * subagent's calls are drawn stepped in behind a rule, and folding one together
 * with a top-level call would put rows from two different frames of reference
 * under a single count.
 */
export function foldsTogether(a: ToolCallItem, b: ToolCallItem): boolean {
  return a.parentToolUseId === b.parentToolUseId
}

/**
 * The family a tool counts as in a run's breakdown.
 *
 * An MCP tool is `mcp__<server>__<tool>`, and the *server* is the useful unit:
 * "3 roam-code" is a thing that happened, where three separate tool names are a
 * list to read. Shell tools from both engines collapse to "shell" for the same
 * reason. Everything else is its own name, lowercased so the breakdown reads as
 * prose rather than as identifiers.
 */
export function toolFamily(name: string): string {
  if (isShellTool(name)) return 'shell'
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)
  if (mcp?.[1]) return mcp[1].replace(/_/g, '-')
  return name.toLowerCase()
}

/**
 * The run's one line.
 *
 * A shell-only run keeps its old wording exactly — "Ran 3 shell commands" — both
 * because it is the commonest run by far and because it is already the sentence
 * people read here; widening the fold should not have re-worded the case that
 * was working. Anything mixed gets the count plus a breakdown, loudest family
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
  // Descending by count, then alphabetical — a stable order matters more than it
  // looks: this string is the row's measured height, so a run whose breakdown
  // reordered between renders would remeasure for no reason.
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family, count]) => `${count} ${family}`)
    .join(', ')
  // The ellipsis trails the whole line, not the count — "Running 2 tools… · 1
  // read, 1 shell" reads as though the sentence ended and then carried on.
  return `${verb}${n} tool${n === 1 ? '' : 's'} · ${breakdown}${tail}`
}

/* ── The task block's one line ─────────────────────────────────────────────
 *
 * A `Task` call and everything its subagent produced collapse to one row (see
 * `blocks.ts`), and these are that row's words. Same contract as `runSummary`:
 * `height.ts` wraps these exact strings to predict the row's pixel height with
 * no DOM, so the component must render them verbatim — two spellings would be
 * two different heights.
 */

const clip = (text: string, max = 80): string =>
  text.length > max ? text.slice(0, max - 1) + '…' : text

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * The row's identity half: which task this is.
 *
 * The Claude SDK's `Task` input carries `subagent_type` (e.g. "Explore") and a
 * 3–5 word `description`, and both are worth the line: parallel tasks are the
 * whole reason the block exists, and two rows both reading `Task(…)` answer
 * nothing. `Task(Explore · find the auth check)` — falling back to the
 * ordinary input preview when an engine sends neither, so the header is never
 * emptier than a plain tool row's.
 */
export function taskLabel(task: ToolCallItem): string {
  const input = task.input as { description?: unknown; subagent_type?: unknown } | null
  const description = trimmed(input?.description)
  const agent = trimmed(input?.subagent_type)
  const inner =
    agent && description
      ? `${agent} · ${clip(description)}`
      : (agent ?? (description ? clip(description) : toolInputPreview(task.input)))
  return `${task.name}(${inner})`
}

const callBusy = (call: ToolCallItem): boolean =>
  call.status === 'running' || call.status === 'pending'

/** Did this one call fail? Both spellings are needed: an out-of-loop execution
 * failure sets `status` with no `is_error` block to read, and an engine can flag
 * `is_error` on a call the reducer has not settled yet. */
export const callFailed = (call: ToolCallItem): boolean =>
  call.status === 'failed' || call.result?.isError === true

/**
 * Does a folded run colour red? **Only when its last call failed.**
 *
 * It used to be `some`, on the argument that a failure should colour the block
 * rather than fragment it. The argument was right about not fragmenting and
 * wrong about `some`: a run is a sequence the model worked through, and a
 * failure it recovered from two calls later is how work goes — a grep that
 * matched nothing, a build fixed on the second go. Reddening the whole run for
 * it means a normal working session is painted red, which spends the colour
 * that should have been left for the one thing still broken.
 *
 * The last call is the run's *outcome*, and an outcome is what a collapsed row
 * can honestly claim. The failures inside it are not hidden — they are one
 * press away, each red on its own row, and the recap counts every one. The
 * **scrubber agrees with this rule** rather than overriding it: it marks a
 * failed call only when the call is its row's outcome, which for a run is
 * exactly this one. It used to mark every member on the argument that the
 * rail asks a different question; against a real session that was nine alarms
 * on the rail for a transcript reddening one row.
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
 * Does the row colour red? **The task's own outcome, and nothing else.**
 *
 * It used to be "or any child call's", which does not survive contact with a
 * real subagent: an agent that ran a hundred calls, one of them a grep that
 * matched nothing, came back with a red line saying it had failed. It had not —
 * it had done exactly what it was asked, and the transcript said otherwise in
 * the one colour reserved for things that need a human.
 *
 * This is the call `SubagentInfo.status` already makes, and it made it for this
 * reason (see `packages/protocol`): the sub-agent's **own** `tool_result`
 * `is_error`, deliberately not `taskFailed`. The argument there was that a
 * nothing-matched grep must not read as a failed run *beside a session name*;
 * what a hundred-call agent shows is that it must not read that way beside the
 * `Task` row either. Two surfaces, one rule, one spelling.
 *
 * Nothing is concealed by this. A failed child is red on its own row, one press
 * away, and the recap counts it. The **scrubber follows this rule too** and no
 * longer marks such a child: a red tick on the rail says precisely what this
 * row is forbidden from saying. The sub-agent band still says an agent ran
 * here, and the task's own red tick still says it came back broken — which is
 * what the two channels are for.
 */
export function taskFailed(task: ToolCallItem): boolean {
  return callFailed(task)
}

/**
 * The collapsed task row's one line: identity, then scale.
 *
 * `Task(Explore · find the auth check) · 7 tools…` while the subagent works —
 * the count grows as it does, which is the row's progress reading, and the
 * trailing ellipsis is the same in-flight signal `runSummary` uses (the pulse
 * in the gutter carries the beat). Settled, the ellipsis drops:
 * `… · 7 tools`. "Tools" and not "tool calls" because `runSummary` already
 * chose that word for the same count one row over.
 *
 * The counts are counted from the absorbed children, never read from the
 * engine's structured Task output — WorkerDeck does not plumb structured tool
 * results to clients, so a transcript replayed tomorrow must spell the same
 * line from the same items it holds today.
 *
 * With no tool calls yet — the subagent thinking, or only its brief arrived —
 * the line says `working…`, because `0 tools…` reads as a stall; settled with
 * none it says `done`.
 */
export function taskSummary(task: ToolCallItem, children: readonly TranscriptItem[]): string {
  const busy = taskBusy(task, children)
  const calls = children.reduce((n, child) => n + (child.kind === 'tool_call' ? 1 : 0), 0)
  const label = taskLabel(task)
  if (calls === 0) return busy ? `${label} · working…` : `${label} · done`
  return `${label} · ${calls} tool${calls === 1 ? '' : 's'}${busy ? '…' : ''}`
}
