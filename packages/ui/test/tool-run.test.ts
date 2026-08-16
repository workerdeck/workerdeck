import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { foldsTogether, runSummary, toolFamily } from '../src/components/terminal/tool-run.ts'

type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

let seq = 0
const call = (name: string, parentToolUseId: string | null = null): ToolCallItem => ({
  kind: 'tool_call',
  id: `t${++seq}`,
  name,
  input: {},
  parentToolUseId,
  status: 'settled',
})

describe('toolFamily', () => {
  it('collapses both engines’ shell tools to one family', () => {
    expect(toolFamily('Bash')).toBe('shell')
    expect(toolFamily('CodexCommand')).toBe('shell')
  })

  it('takes the server, not the tool, out of an MCP name', () => {
    expect(toolFamily('mcp__roam_code__roam_uses')).toBe('roam-code')
    expect(toolFamily('mcp__gtm__TaskUpsert')).toBe('gtm')
  })

  it('keeps a hyphenated server name whole', () => {
    // The regex is lazy across `_`-joined segments, so the *first* `__` after at
    // least one segment ends the server. A `chrome-devtools` server arrives as
    // `chrome_devtools` and must not truncate to `chrome`.
    expect(toolFamily('mcp__chrome_devtools__take_screenshot')).toBe('chrome-devtools')
    expect(toolFamily('mcp__plugin_gtm_warehouse__execute_query')).toBe('plugin-gtm-warehouse')
  })

  it('lowercases anything else so a breakdown reads as prose', () => {
    expect(toolFamily('Read')).toBe('read')
    expect(toolFamily('WebFetch')).toBe('webfetch')
  })
})

describe('runSummary', () => {
  it('keeps the shell-only wording exactly, singular and plural', () => {
    expect(runSummary([call('Bash')], false)).toBe('Ran 1 shell command')
    expect(runSummary([call('Bash'), call('CodexCommand'), call('Bash')], false)).toBe(
      'Ran 3 shell commands',
    )
  })

  it('gives a mixed run the count plus a breakdown', () => {
    const items = [
      call('Bash'),
      call('mcp__roam_code__roam_uses'),
      call('Read'),
      call('mcp__roam_code__roam_grep'),
      call('mcp__roam_code__roam_deps'),
      call('Bash'),
    ]
    expect(runSummary(items, false)).toBe('Ran 6 tools · 3 roam-code, 2 shell, 1 read')
  })

  it('orders the breakdown by count, then alphabetically', () => {
    // A stable order is load-bearing: this string *is* the row's measured
    // height, so a breakdown that reordered between renders would remeasure.
    const items = [call('Read'), call('mcp__gtm__TaskUpsert'), call('WebFetch')]
    expect(runSummary(items, false)).toBe('Ran 3 tools · 1 gtm, 1 read, 1 webfetch')
  })

  it('is not shell-only wording when a single non-shell tool folded alone', () => {
    expect(runSummary([call('Read')], false)).toBe('Ran 1 tool · 1 read')
  })

  it('trails the ellipsis on the whole line while busy, never on the count', () => {
    expect(runSummary([call('Bash'), call('Bash')], true)).toBe('Running 2 shell commands…')
    expect(runSummary([call('Bash'), call('Read')], true)).toBe(
      'Running 2 tools · 1 read, 1 shell…',
    )
  })
})

describe('foldsTogether', () => {
  it('folds two top-level calls', () => {
    expect(foldsTogether(call('Bash'), call('Read'))).toBe(true)
  })

  it('refuses to fold a subagent’s call with a top-level one', () => {
    // They are drawn in two different frames of reference — one stepped in
    // behind a rule — so a single count over both would claim they were one act.
    expect(foldsTogether(call('Bash'), call('Read', 'agent-1'))).toBe(false)
    expect(foldsTogether(call('Bash', 'agent-1'), call('Read', 'agent-2'))).toBe(false)
  })

  it('folds two calls from the same subagent', () => {
    expect(foldsTogether(call('Bash', 'agent-1'), call('Read', 'agent-1'))).toBe(true)
  })
})
