import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import {
  taskChildItems,
  terminalBlocks,
  type TaskBlock,
  type ToolCallItem,
} from '../src/components/terminal/blocks.ts'
import {
  blockHeight,
  createHeightEpoch,
  estimateBlockPx,
  textLines,
} from '../src/components/terminal/height.ts'
import { taskSummary } from '../src/components/terminal/tool-run.ts'
import {
  gapBefore,
  rowIndexForItem,
  rowItem,
  type TranscriptRow,
} from '../src/components/agent/transcript-rows.ts'

/**
 * The item-index → row-index mapping under the task-block model — the
 * off-by-a-fold trap's unit half. The dev harness (`__wdCheckMapping`) sweeps
 * the real fixtures in a browser; this file sweeps constructed interleavings,
 * which the fixtures do not carry, and checks the property that matters
 * independently of the implementation: the returned row must literally
 * CONTAIN the item, and exactly one row may contain each item.
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
  ...(parent !== undefined ? { parentToolUseId: parent } : {}),
})
const task = (id: string, input: unknown = {}): TranscriptItem => ({
  kind: 'tool_call',
  id,
  name: 'Task',
  input,
  parentToolUseId: null,
  status: 'settled',
})

/** The transcripts the mapping must survive. Each is a shape the stream can
 * really take; `parallel` is the one the contiguous model breaks on. */
const TRANSCRIPTS: Record<string, TranscriptItem[]> = {
  plain: [user('go'), text('sure'), tool('Bash'), tool('Read'), text('done')],
  contiguousTask: [user('go'), task('A'), user('brief', 'A'), tool('Read', 'A'), text('done')],
  parallel: [
    user('go'),
    task('A'),
    task('B'),
    tool('Read', 'A'),
    tool('Grep', 'B'),
    text('aside'),
    tool('Bash', 'A'),
    tool('Edit', 'B'),
    text('done'),
  ],
  // Two top-level calls separated only by absorbed items fold into one run —
  // the run whose coverage index arithmetic can no longer describe.
  gappedRun: [task('A'), tool('Bash'), tool('Read', 'A'), tool('Bash'), text('done')],
  orphans: [tool('Read', 'gone'), tool('Grep', 'gone'), text('done')],
  grandchild: [task('A'), tool('Task', 'A', 'B'), tool('Read', 'B'), text('done')],
}

const buildRows = (items: TranscriptItem[], boundary?: number): TranscriptRow[] =>
  boundary === undefined
    ? terminalBlocks(items, 0, true)
    : [
        ...terminalBlocks(items.slice(0, boundary), 0, true),
        { key: 'recap' as const, line: 'check' },
        ...terminalBlocks(items.slice(boundary), boundary, true),
      ]

/** Does this row literally contain the item? Identity, not index arithmetic. */
const contains = (row: TranscriptRow, item: TranscriptItem): boolean => {
  if ('run' in row) return (row.run as TranscriptItem[]).includes(item)
  if ('task' in row) return row.task === item || taskChildItems(row).includes(item)
  if ('item' in row) return row.item === item
  return false
}

describe('rowIndexForItem', () => {
  it('lands every item on the one row that contains it, across every splice', () => {
    for (const [name, items] of Object.entries(TRANSCRIPTS)) {
      const boundaries = [undefined, 1, Math.floor(items.length / 2), items.length - 1]
      for (const boundary of boundaries) {
        const rows = buildRows(items, boundary)
        for (let i = 0; i < items.length; i++) {
          const owners = rows.filter((row) => contains(row, items[i]!))
          // Exactly one row contains each item — absorbed children must not
          // ALSO stand as top-level rows.
          expect(owners, `${name} boundary=${String(boundary)} item=${i} owners`).toHaveLength(1)
          const got = rows[rowIndexForItem(rows, i)]!
          expect(
            contains(got, items[i]!),
            `${name} boundary=${String(boundary)} item=${i} → ${got.key}`,
          ).toBe(true)
        }
      }
    }
  })

  it('maps an absorbed child to its task’s row, wherever it fell in the stream', () => {
    const rows = buildRows(TRANSCRIPTS.parallel!)
    // Item 6 is task A's second call, far past task B's row and the aside.
    expect(rows[rowIndexForItem(rows, 6)]!.key).toBe('task:A')
    expect(rows[rowIndexForItem(rows, 7)]!.key).toBe('task:B')
    // The tasks' own indices land on their own rows.
    expect(rows[rowIndexForItem(rows, 1)]!.key).toBe('task:A')
    expect(rows[rowIndexForItem(rows, 2)]!.key).toBe('task:B')
  })

  it('answers from the later run for an index past an absorbed gap', () => {
    const rows = buildRows(TRANSCRIPTS.gappedRun!)
    // Items 1 and 3 folded into one run across the absorbed item 2.
    const runRow = rowIndexForItem(rows, 3)
    expect(rows[runRow]!.key).toBe(`run:${(TRANSCRIPTS.gappedRun![1] as ToolCallItem).id}`)
    expect(rowIndexForItem(rows, 1)).toBe(runRow)
    expect(rows[rowIndexForItem(rows, 2)]!.key).toBe('task:A')
  })

  it('never answers the recap row at the boundary', () => {
    for (const items of Object.values(TRANSCRIPTS)) {
      for (let boundary = 1; boundary < items.length; boundary++) {
        const rows = buildRows(items, boundary)
        for (let i = 0; i < items.length; i++) {
          expect(rows[rowIndexForItem(rows, i)]!.key).not.toBe('recap')
        }
      }
    }
  })
})

describe('rowItem / gapBefore', () => {
  it('spaces a task row as the Task call it stands for', () => {
    const rows = buildRows([task('A'), tool('Read', 'A'), tool('Bash'), text('done')])
    expect(rowItem(rows[0])).toMatchObject({ kind: 'tool_call', id: 'A' })
    // Task row and the run below it are one block: no blank line between.
    expect(gapBefore(rows, 1)).toBe(false)
    // The answer after them starts a new block.
    expect(gapBefore(rows, 2)).toBe(true)
  })
})

describe('task block height', () => {
  const m = { width: 400, ch: 8, line: 18 } // 48 columns for a 2-cell gutter
  const taskBlockOf = (items: TranscriptItem[]): TaskBlock => {
    const block = terminalBlocks(items)[0]!
    if (!('task' in block)) throw new Error('expected a task block')
    return block
  }

  it('is one Row of exactly the shared summary string', () => {
    const block = taskBlockOf([task('A', { description: 'find it' }), tool('Read', 'A')])
    const summary = taskSummary(block.task, taskChildItems(block))
    const cols = Math.floor((m.width - 2 * m.ch) / m.ch)
    const { px, exact } = blockHeight(block, m)
    expect(px).toBe(textLines(summary, cols).lines * m.line)
    expect(px).toBe(m.line) // this summary fits one line at 48 columns
    expect(exact).toBe(true)
  })

  it('measures in the standard 2-cell gutter, to the column', () => {
    // This summary is exactly 48 cells, the column count a 2-cell gutter
    // leaves at these metrics: one line there, two anywhere narrower. A wrong
    // gutter constant in the height path moves this row and nothing obvious.
    const block = taskBlockOf([task('A', { description: 'x'.repeat(33) }), tool('Read', 'A')])
    expect(taskSummary(block.task, taskChildItems(block))).toHaveLength(48)
    expect(blockHeight(block, m).px).toBe(m.line)
  })

  it('wraps like the renderer will — the collapsed row is not clamped to one line', () => {
    const block = taskBlockOf([task('A', { description: 'x'.repeat(60) }), tool('Read', 'A')])
    // `Task(` + 60 + `)` is a 66-cell token: break-word gives it its own two
    // lines at 48 columns and the count trails on the second.
    expect(blockHeight(block, m).px).toBe(2 * m.line)
  })

  it('is never cached against the task item — children change under it', () => {
    // The reducer replaces the CHILD on mutation, not the Task call, so a
    // height keyed on the task object would survive exactly the change that
    // moves the summary line.
    const narrow = createHeightEpoch(152, 8, 18) // 17 columns
    const call = task('A', { description: 'x' })
    const one = taskBlockOf([call, tool('Read', 'A')])
    const grown = taskBlockOf([
      call,
      ...Array.from({ length: 10 }, () => tool('Read', 'A')),
    ])
    expect(narrow.cache.get(call)).toBeUndefined()
    const before = estimateBlockPx(one, narrow) // `Task(x) · 1 tool` — one line
    const after = estimateBlockPx(grown, narrow) // `Task(x) · 10 tools` — wraps
    expect(narrow.cache.get(call)).toBeUndefined()
    expect(before).toBe(18)
    expect(after).toBe(36)
  })
})
