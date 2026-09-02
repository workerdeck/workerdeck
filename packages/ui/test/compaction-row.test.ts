import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { COMPACTION_TEXT } from '../src/lib/format.ts'
import { terminalBlocks } from '../src/components/terminal/blocks.ts'
import { itemHeight, type CellMetrics } from '../src/components/terminal/height.ts'

const m: CellMetrics = { width: 800, ch: 8, line: 18 }

function compaction(parentToolUseId: string | null = null, id = 'c1'): TranscriptItem {
  return { kind: 'compaction', id, parentToolUseId }
}

function text(body: string, id = 'a1'): TranscriptItem {
  return { kind: 'assistant_text', id, text: body, streaming: false, parentToolUseId: null }
}

describe('the compaction boundary', () => {
  it('measures exactly one line, and stays exact', () => {
    const h = itemHeight(compaction(), m)
    expect(h.px).toBe(m.line)
    expect(h.exact).toBe(true)
  })

  it('is measured against the string it draws, never a copy of it', () => {
    const items = readFileSync(new URL('../src/components/terminal/items.tsx', import.meta.url), 'utf8')
    const height = readFileSync(new URL('../src/components/terminal/height.ts', import.meta.url), 'utf8')
    expect(items).toContain('COMPACTION_TEXT')
    expect(height).toContain('rowH(COMPACTION_TEXT, m, { extraPx })')
    expect(items).not.toContain(`'${COMPACTION_TEXT}'`)
    expect(height).not.toContain(`'${COMPACTION_TEXT}'`)
  })

  it('folds as its own block — it never joins a tool run or swallows a neighbour', () => {
    const blocks = terminalBlocks([text('before'), compaction(), text('after', 'a2')])
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toMatchObject({ key: 'compaction:c1' })
  })

  it("nests under a sub-agent's task when it was that agent's context that compacted", () => {
    const task: TranscriptItem = { kind: 'tool_call', id: 'call_a', name: 'Task', input: {}, parentToolUseId: null, status: 'settled' }
    const blocks = terminalBlocks([task, compaction('call_a')])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ key: expect.stringContaining('call_a') })
  })
})
