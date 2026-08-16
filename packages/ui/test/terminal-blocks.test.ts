import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { blockNeedsBlank, terminalBlocks } from '../src/components/terminal/items.tsx'

/**
 * Which rows exist. This is part of what the terminal theme *is* — the
 * virtualizer counts these, and `height.ts` sizes them — so a change here is a
 * change to the transcript, not to its styling.
 */

let seq = 0
const tool = (
  name: string,
  parentToolUseId: string | null = null,
  id = `t${++seq}`,
): TranscriptItem => ({
  kind: 'tool_call',
  id,
  name,
  input: {},
  parentToolUseId,
  status: 'settled',
})
const text = (body: string, parentToolUseId: string | null = null): TranscriptItem => ({
  kind: 'assistant_text',
  id: `a${++seq}`,
  text: body,
  streaming: false,
  parentToolUseId,
})
const user = (body: string, parent?: string): TranscriptItem => ({
  kind: 'user',
  id: `u${++seq}`,
  text: body,
  // The brief's shape exactly: the key exists only on a subagent's brief.
  ...(parent !== undefined ? { parentToolUseId: parent } : {}),
})
/** A `Task` call with a chosen id, so children can name it. */
const task = (id: string, input: unknown = {}): TranscriptItem => ({
  kind: 'tool_call',
  id,
  name: 'Task',
  input,
  parentToolUseId: null,
  status: 'running',
})

const shape = (blocks: ReturnType<typeof terminalBlocks>) =>
  blocks.map((b) =>
    'run' in b ? `run(${b.run.length})` : 'task' in b ? `task(${b.childIndices.length})` : b.item.kind,
  )

describe('terminalBlocks', () => {
  it('folds a run of consecutive tool calls into one block', () => {
    const items = [text('working'), tool('Bash'), tool('Read'), tool('Bash'), text('done')]
    expect(shape(terminalBlocks(items))).toEqual([
      'assistant_text',
      'run(3)',
      'assistant_text',
    ])
  })

  it('breaks a run on anything the model said between two calls', () => {
    // The sentence between them is the reason the second call happened; a count
    // spanning it would claim the two were one act.
    const items = [tool('Bash'), text('that failed, trying again'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['run(1)', 'assistant_text', 'run(1)'])
  })

  it('breaks a run on a prompt', () => {
    expect(shape(terminalBlocks([tool('Bash'), user('stop'), tool('Bash')]))).toEqual([
      'run(1)',
      'user',
      'run(1)',
    ])
  })

  it('does not fold a subagent’s calls together with top-level ones', () => {
    const items = [tool('Bash'), tool('Read', 'agent-1'), tool('Grep', 'agent-1'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['run(1)', 'run(2)', 'run(1)'])
  })

  it('keys a run by its first call, so the key is stable as the run grows', () => {
    const items = [tool('Bash'), tool('Read')]
    const first = terminalBlocks(items.slice(0, 1))[0]!
    const grown = terminalBlocks(items)[0]!
    expect(grown.key).toBe(first.key)
    expect(grown.key).toBe(`run:${items[0]!.id}`)
  })

  it('gives one block per item with fold off — the cards variant’s row list', () => {
    const items = [tool('Bash'), tool('Read'), tool('Bash')]
    expect(shape(terminalBlocks(items, 0, false))).toEqual([
      'tool_call',
      'tool_call',
      'tool_call',
    ])
  })

  it('reports each block’s index in the whole transcript, not the slice', () => {
    // The virtualized shell folds each side of the recap boundary separately and
    // the rows still have to say where they sit, for the catch-up dimming.
    const items = [text('a'), tool('Bash'), tool('Read'), text('b')]
    expect(terminalBlocks(items.slice(1), 1).map((b) => b.index)).toEqual([1, 3])
  })

  it('never folds across a boundary the caller split at', () => {
    const items = [tool('Bash'), tool('Read'), tool('Grep')]
    const split = [...terminalBlocks(items.slice(0, 1), 0), ...terminalBlocks(items.slice(1), 1)]
    expect(shape(split)).toEqual(['run(1)', 'run(2)'])
  })

  it('does not mutate the items it is given', () => {
    const items = [tool('Bash'), tool('Read')]
    const before = JSON.stringify(items)
    terminalBlocks(items)
    expect(JSON.stringify(items)).toBe(before)
  })
})

describe('terminalBlocks · task absorption', () => {
  it('absorbs a Task call and everything its subagent produced into one row', () => {
    const items = [
      task('A'),
      user('brief', 'A'),
      text('thinking it over', 'A'),
      tool('Read', 'A'),
      tool('Grep', 'A'),
      text('done'),
    ]
    expect(shape(terminalBlocks(items))).toEqual(['task(4)', 'assistant_text'])
  })

  it('absorbs interleaved children of parallel tasks, wherever they fall', () => {
    // The crux: subagents run in parallel, so their items are NOT contiguous.
    // A consecutive-run rule would leave B's call standing between A's rows.
    const items = [
      task('A'),
      task('B'),
      tool('Read', 'A'),
      tool('Grep', 'B'),
      text('top-level aside'),
      tool('Bash', 'A'),
    ]
    const blocks = terminalBlocks(items)
    expect(shape(blocks)).toEqual(['task(2)', 'task(1)', 'assistant_text'])
    expect(blocks[0]).toMatchObject({ key: 'task:A', index: 0, childIndices: [2, 5] })
    expect(blocks[1]).toMatchObject({ key: 'task:B', index: 1, childIndices: [3] })
  })

  it('folds a subagent’s consecutive calls into runs within the block', () => {
    // Consecutive in the SUBAGENT'S stream: B's interleaved call is another
    // frame's work and must not break A's run — while A's own sentence must.
    const items = [
      task('A'),
      task('B'),
      tool('Read', 'A'),
      tool('Grep', 'B'),
      tool('Bash', 'A'),
      text('now the fix', 'A'),
      tool('Edit', 'A'),
    ]
    const a = terminalBlocks(items)[0]!
    if (!('task' in a)) throw new Error('expected a task block')
    expect(
      a.children.map((c) => ('run' in c ? `run(${c.run.length})` : c.item.kind)),
    ).toEqual(['run(2)', 'assistant_text', 'run(1)'])
    // Each child block's index is its first member's GLOBAL transcript index.
    expect(a.children.map((c) => c.index)).toEqual([2, 5, 6])
  })

  it('never renders an absorbed item as a top-level row too', () => {
    const items = [task('A'), tool('Read', 'A'), text('after')]
    const blocks = terminalBlocks(items)
    // Two rows: the task and the text. The child appears only inside the task.
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.index)).toEqual([0, 2])
  })

  it('leaves a childless Task call in the ordinary run fold', () => {
    // Still spawning, or its children compacted away — a plain tool call.
    expect(shape(terminalBlocks([task('A'), tool('Bash')]))).toEqual(['run(2)'])
  })

  it('breaks the run fold on a task block, like any other row between calls', () => {
    const items = [tool('Bash'), task('A'), tool('Read', 'A'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['run(1)', 'task(1)', 'run(1)'])
  })

  it('folds two top-level calls separated only by absorbed items', () => {
    // Once the subagent's step is absorbed into the task row above, the two
    // calls are adjacent on screen — the count matches what the reader sees.
    const items = [task('A'), tool('Bash'), tool('Read', 'A'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['task(1)', 'run(2)'])
  })

  it('keeps an orphan child as its own row when its Task call is absent', () => {
    // A caller's split (the recap boundary) makes exactly this: the call on one
    // side, later children on the other. New work must not hide inside a
    // collapsed row above the seam — the run fold's own boundary rule.
    const items = [task('A'), tool('Read', 'A'), tool('Grep', 'A')]
    const split = [...terminalBlocks(items.slice(0, 1), 0), ...terminalBlocks(items.slice(1), 1)]
    expect(shape(split)).toEqual(['run(1)', 'run(2)'])
    expect(split[1]!.index).toBe(1)
  })

  it('keys a task by its call, so the key is stable as children arrive', () => {
    const items = [task('A'), tool('Read', 'A'), tool('Grep', 'A')]
    const early = terminalBlocks(items.slice(0, 2))[0]!
    const grown = terminalBlocks(items)[0]!
    expect(early.key).toBe('task:A')
    expect(grown.key).toBe(early.key)
  })

  it('does not absorb at all with fold off — the cards variant’s row list', () => {
    const items = [task('A'), tool('Read', 'A')]
    expect(shape(terminalBlocks(items, 0, false))).toEqual(['tool_call', 'tool_call'])
  })

  it('reports child indices against the whole transcript under an offset', () => {
    const items = [text('lead-in'), task('A'), tool('Read', 'A')]
    const blocks = terminalBlocks(items.slice(1), 1)
    expect(blocks[0]).toMatchObject({ index: 1, childIndices: [2] })
  })

  it('spaces a task block as a tool call — flush with the calls of its turn', () => {
    const blocks = terminalBlocks([text('on it'), task('A'), tool('Read', 'A'), tool('Bash')])
    expect(blocks).toHaveLength(3)
    expect(blockNeedsBlank(blocks[0]!, blocks[1]!)).toBe(true) // answer → task
    expect(blockNeedsBlank(blocks[1]!, blocks[2]!)).toBe(false) // task → run
  })

  it('renders a grandchild as its own row rather than dropping it', () => {
    // No engine nests sidechains today, but an unmapped item must be visible,
    // never gone: the inner call is absorbed by A, and the inner call's own
    // child — whose parent is not a top-level call — stays a top-level row.
    const items = [task('A'), tool('Task', 'A', 'B'), tool('Read', 'B')]
    const blocks = terminalBlocks(items)
    expect(shape(blocks)).toEqual(['task(1)', 'run(1)'])
    expect(blocks[1]!.index).toBe(2)
  })
})
