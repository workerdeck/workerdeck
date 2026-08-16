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
