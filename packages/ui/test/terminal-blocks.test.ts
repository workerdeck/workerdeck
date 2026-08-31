import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { blockNeedsBlank, terminalBlocks } from '../src/components/terminal/items.tsx'
import { subagentItems } from '../src/components/terminal/blocks.ts'

let seq = 0
const tool = (name: string, parentToolUseId: string | null = null, id = `t${++seq}`): TranscriptItem => ({
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
const task = (id: string, input: unknown = {}): TranscriptItem => ({
  kind: 'tool_call',
  id,
  name: 'Task',
  input,
  parentToolUseId: null,
  status: 'running',
})

const shape = (blocks: ReturnType<typeof terminalBlocks>) =>
  blocks.map((b) => ('run' in b ? `run(${b.run.length})` : 'task' in b ? `task(${b.childIndices.length})` : b.item.kind))

describe('terminalBlocks', () => {
  it('folds a run of consecutive tool calls into one block', () => {
    const items = [text('working'), tool('Bash'), tool('Read'), tool('Bash'), text('done')]
    expect(shape(terminalBlocks(items))).toEqual(['assistant_text', 'run(3)', 'assistant_text'])
  })

  it('breaks a run on anything the model said between two calls', () => {
    const items = [tool('Bash'), text('that failed, trying again'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['run(1)', 'assistant_text', 'run(1)'])
  })

  it('breaks a run on a prompt', () => {
    expect(shape(terminalBlocks([tool('Bash'), user('stop'), tool('Bash')]))).toEqual(['run(1)', 'user', 'run(1)'])
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
    expect(shape(terminalBlocks(items, 0, false))).toEqual(['tool_call', 'tool_call', 'tool_call'])
  })

  it('reports each block’s index in the whole transcript, not the slice', () => {
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

describe('terminalBlocks · run indices', () => {
  it('records every member’s global index, respecting the slice offset', () => {
    const items = [text('go'), tool('Bash'), tool('Read'), text('done')]
    const run = terminalBlocks(items)[1]!
    if (!('run' in run)) {
      throw new Error('expected a run block')
    }
    expect(run.indices).toEqual([1, 2])
    const offset = terminalBlocks(items.slice(1), 1)[0]!
    if (!('run' in offset)) {
      throw new Error('expected a run block')
    }
    expect(offset.indices).toEqual([1, 2])
  })

  it('skips the absorbed item a run folded across', () => {
    // The gapped run: two top-level calls separated only by a subagent's step are adjacent on screen.
    const items = [task('A'), tool('Bash'), tool('Read', 'A'), tool('Bash'), text('done')]
    const run = terminalBlocks(items)[1]!
    if (!('run' in run)) {
      throw new Error('expected a run block')
    }
    expect(run.indices).toEqual([1, 3])
    expect(run.index).toBe(1)
  })
})

describe('terminalBlocks · task absorption', () => {
  it('absorbs a Task call and everything its subagent produced into one row', () => {
    const items = [task('A'), user('brief', 'A'), text('thinking it over', 'A'), tool('Read', 'A'), tool('Grep', 'A'), text('done')]
    expect(shape(terminalBlocks(items))).toEqual(['task(4)', 'assistant_text'])
  })

  it('absorbs interleaved children of parallel tasks, wherever they fall', () => {
    const items = [task('A'), task('B'), tool('Read', 'A'), tool('Grep', 'B'), text('top-level aside'), tool('Bash', 'A')]
    const blocks = terminalBlocks(items)
    expect(shape(blocks)).toEqual(['task(2)', 'task(1)', 'assistant_text'])
    expect(blocks[0]).toMatchObject({ key: 'task:A', index: 0, childIndices: [2, 5] })
    expect(blocks[1]).toMatchObject({ key: 'task:B', index: 1, childIndices: [3] })
  })

  it('folds a subagent’s consecutive calls into runs within the block', () => {
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
    if (!('task' in a)) {
      throw new Error('expected a task block')
    }
    expect(a.children.map((c) => ('run' in c ? `run(${c.run.length})` : c.item.kind))).toEqual(['run(2)', 'assistant_text', 'run(1)'])
    expect(a.children.map((c) => c.index)).toEqual([2, 5, 6])
  })

  it('never renders an absorbed item as a top-level row too', () => {
    const items = [task('A'), tool('Read', 'A'), text('after')]
    const blocks = terminalBlocks(items)
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.index)).toEqual([0, 2])
  })

  it('leaves a childless Task call in the ordinary run fold', () => {
    expect(shape(terminalBlocks([task('A'), tool('Bash')]))).toEqual(['run(2)'])
  })

  it('breaks the run fold on a task block, like any other row between calls', () => {
    const items = [tool('Bash'), task('A'), tool('Read', 'A'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['run(1)', 'task(1)', 'run(1)'])
  })

  it('folds two top-level calls separated only by absorbed items', () => {
    const items = [task('A'), tool('Bash'), tool('Read', 'A'), tool('Bash')]
    expect(shape(terminalBlocks(items))).toEqual(['task(1)', 'run(2)'])
  })

  it('keeps an orphan child as its own row when its Task call is absent', () => {
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
    const items = [task('A'), tool('Task', 'A', 'B'), tool('Read', 'B')]
    const blocks = terminalBlocks(items)
    expect(shape(blocks)).toEqual(['task(1)', 'run(1)'])
    expect(blocks[1]!.index).toBe(2)
  })
})

describe('subagentItems', () => {
  it('takes everything the agent produced, and nothing else', () => {
    const items = [
      user('do the thing'),
      task('T1', { subagent_type: 'Explore', description: 'find the auth check' }),
      user('find the auth check', 'T1'),
      text('looking', 'T1'),
      tool('Grep', 'T1'),
      tool('Bash'),
      text('here it is', 'T1'),
      text('all done'),
    ]
    expect(subagentItems(items, 'T1').map((i) => i.kind)).toEqual([
      // The brief, the thinking-aloud, the tool call and the final report.
      'user',
      'assistant_text',
      'tool_call',
      'assistant_text',
    ])
  })

  it('excludes the spawning Task call itself — that is the frame, not a row in it', () => {
    const items = [task('T1'), tool('Grep', 'T1')]
    const framed = subagentItems(items, 'T1')
    expect(framed.some((i) => i.id === 'T1')).toBe(false)
    expect(framed).toHaveLength(1)
  })

  it('keeps two parallel agents apart', () => {
    const items = [task('T1'), task('T2'), tool('Grep', 'T1'), tool('Bash', 'T2'), tool('Read', 'T1')]
    const names = (parent: string) => subagentItems(items, parent).map((i) => (i.kind === 'tool_call' ? i.name : i.kind))
    expect(names('T1')).toEqual(['Grep', 'Read'])
    expect(names('T2')).toEqual(['Bash'])
  })

  it('is empty for a top-level id and for one nobody spawned', () => {
    const items = [user('hi'), tool('Bash')]
    expect(subagentItems(items, 'nope')).toEqual([])
  })

  it('folds runs inside the frame, and absorbs nothing', () => {
    const items = [task('T1'), user('go', 'T1'), tool('Grep', 'T1'), tool('Read', 'T1'), text('done', 'T1')]
    expect(shape(terminalBlocks(subagentItems(items, 'T1'), 0, true))).toEqual(['user', 'run(2)', 'assistant_text'])
  })
})
