import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { terminalBlocks } from '../src/components/terminal/items.tsx'

/**
 * Which rows exist. This is part of what the terminal theme *is* — the
 * virtualizer counts these, and `height.ts` sizes them — so a change here is a
 * change to the transcript, not to its styling.
 */

let seq = 0
const tool = (name: string, parentToolUseId: string | null = null): TranscriptItem => ({
  kind: 'tool_call',
  id: `t${++seq}`,
  name,
  input: {},
  parentToolUseId,
  status: 'settled',
})
const text = (body: string): TranscriptItem => ({
  kind: 'assistant_text',
  id: `a${++seq}`,
  text: body,
  streaming: false,
  parentToolUseId: null,
})
const user = (body: string): TranscriptItem => ({ kind: 'user', id: `u${++seq}`, text: body })

const shape = (blocks: ReturnType<typeof terminalBlocks>) =>
  blocks.map((b) => ('run' in b ? `run(${b.run.length})` : b.item.kind))

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
