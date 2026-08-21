import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import {
  foldsTogether,
  runFailed,
  runSummary,
  taskBrief,
  taskBusy,
  taskFailed,
  taskLabel,
  taskSummary,
  toolFamily,
} from '../src/components/terminal/tool-run.ts'

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

/* ── The task block's one line ────────────────────────────────────────────── */

const taskCall = (over: Partial<ToolCallItem> = {}): ToolCallItem => ({
  kind: 'tool_call',
  id: 'task-1',
  name: 'Task',
  input: { subagent_type: 'Explore', description: 'find the auth check' },
  parentToolUseId: null,
  status: 'settled',
  ...over,
})
const brief: TranscriptItem = {
  kind: 'user',
  id: 'u1',
  text: 'go find it',
  parentToolUseId: 'task-1',
}
const said: TranscriptItem = {
  kind: 'assistant_text',
  id: 'a1',
  text: 'found it',
  streaming: false,
  parentToolUseId: 'task-1',
}

describe('taskBrief', () => {
  it('is the call’s prompt — the one place the engine puts the instruction', () => {
    // Measured against a live claude session: the Agent SDK sends
    // {description, subagent_type, run_in_background, prompt} and never emits
    // the brief as a nested user message, so no `parentToolUseId` item carries
    // it and only the call does.
    expect(taskBrief(taskCall({ input: { prompt: 'Find every caller of parseRoute.' } }))).toBe(
      'Find every caller of parseRoute.',
    )
  })

  it('is the fallback for a background agent, whose stream carries no brief at all', () => {
    // The distinction that decides whether the row is drawn: a foreground Task
    // forwards its brief as a real nested user item (the reducer stamps the
    // parent on it), so the frame already has one and the callers skip this. A
    // background agent forwards nothing — measured on a session with eight —
    // and those are exactly the runs a takeover gets opened on. `taskBrief`
    // itself answers the same either way; the guard lives at the call sites.
    expect(taskBrief(taskCall({ input: { prompt: 'Go.', run_in_background: true } }))).toBe('Go.')
  })

  it('is absent when the engine has no brief to give, and never borrows the description', () => {
    // Codex is this case for real: its spawn message is encrypted on the wire.
    // Falling back to `description` would claim we know the instruction when we
    // have only the 3–5 word label the header already prints.
    expect(taskBrief(taskCall({ input: { description: 'find the auth check' } }))).toBeUndefined()
    expect(taskBrief(taskCall({ input: {} }))).toBeUndefined()
    expect(taskBrief(taskCall({ input: { prompt: '   ' } }))).toBeUndefined()
  })
})

describe('taskLabel', () => {
  it('names the agent and the description, both from the call’s own input', () => {
    expect(taskLabel(taskCall())).toBe('Task(Explore · find the auth check)')
  })

  it('takes whichever half an engine sent, without a dangling separator', () => {
    expect(taskLabel(taskCall({ input: { subagent_type: 'Explore' } }))).toBe('Task(Explore)')
    expect(taskLabel(taskCall({ input: { description: 'find it' } }))).toBe('Task(find it)')
  })

  it('falls back to the ordinary input preview when neither is there', () => {
    expect(taskLabel(taskCall({ input: { prompt: 'x' } }))).toBe('Task({"prompt":"x"})')
  })

  it('treats a blank-padded description as absent, not as a name', () => {
    // A model told to omit an optional field sends "" or " " — the same lesson
    // `apps/embedded` paid for. `Task( )` would be that bug, drawn; the fallback
    // preview happens to be empty for this input too, which is exactly what the
    // plain tool row's header shows for it.
    expect(taskLabel(taskCall({ input: { subagent_type: ' ', description: '' } }))).toBe('Task()')
  })

  it('clips a long description the way tool previews clip', () => {
    const description = 'x'.repeat(200)
    const label = taskLabel(taskCall({ input: { description } }))
    expect(label).toBe(`Task(${'x'.repeat(79)}…)`)
  })
})

describe('taskSummary', () => {
  it('counts the subagent’s tool calls, settled', () => {
    const children = [brief, said, call('Read', 'task-1'), call('Grep', 'task-1')]
    expect(taskSummary(taskCall(), children)).toBe(
      'Task(Explore · find the auth check) · 2 tools',
    )
  })

  it('trails the ellipsis while the subagent works, and keeps counting', () => {
    const children = [brief, call('Read', 'task-1')]
    expect(taskSummary(taskCall({ status: 'running' }), children)).toBe(
      'Task(Explore · find the auth check) · 1 tool…',
    )
  })

  it('says working, not “0 tools”, before the first call lands', () => {
    expect(taskSummary(taskCall({ status: 'running' }), [brief])).toBe(
      'Task(Explore · find the auth check) · working…',
    )
  })

  it('says done for a task that settled without calling anything', () => {
    expect(taskSummary(taskCall(), [brief, said])).toBe(
      'Task(Explore · find the auth check) · done',
    )
  })
})

describe('taskBusy', () => {
  it('follows the call’s own status', () => {
    expect(taskBusy(taskCall({ status: 'running' }), [])).toBe(true)
    expect(taskBusy(taskCall({ status: 'pending' }), [])).toBe(true)
    expect(taskBusy(taskCall(), [])).toBe(false)
  })

  it('stays busy while a child call still runs, even after the task settled', () => {
    // A bridged or deferred child can outlive the call; a pulse that stopped
    // while one still worked would read as a hang.
    const children = [{ ...call('Read', 'task-1'), status: 'running' as const }]
    expect(taskBusy(taskCall(), children)).toBe(true)
  })
})

describe('taskFailed', () => {
  it('colours on the task’s own failure, by either spelling', () => {
    expect(taskFailed(taskCall({ status: 'failed' }))).toBe(true)
    expect(taskFailed(taskCall({ result: { text: 'no', isError: true } }))).toBe(true)
    expect(taskFailed(taskCall())).toBe(false)
  })

  it('does not colour on a child’s failure — the agent’s outcome is the claim', () => {
    // The case that motivated the rule: an agent runs a hundred calls, one of
    // them a grep that matched nothing, and comes back having done exactly what
    // it was asked. A red line saying otherwise spends the one colour reserved
    // for things that need a human. The child is still red on its own row.
    const children = [{ ...call('Read', 'task-1'), status: 'failed' as const }]
    expect(taskFailed(taskCall())).toBe(false)
    expect(children).toHaveLength(1)
  })
})

describe('runFailed', () => {
  it('is the run’s last call, not any of them', () => {
    const ok = call('Read')
    const bad = { ...call('Bash'), status: 'failed' as const }
    // Recovered: the failure is history, and the run's outcome is fine.
    expect(runFailed([bad, ok])).toBe(false)
    // Unresolved: the run ended on it, so it is still the live fact.
    expect(runFailed([ok, bad])).toBe(true)
  })

  it('reads both spellings of a failure, and an empty run never fails', () => {
    expect(runFailed([{ ...call('Bash'), result: { text: 'no', isError: true } }])).toBe(true)
    expect(runFailed([call('Read')])).toBe(false)
    expect(runFailed([])).toBe(false)
  })
})
