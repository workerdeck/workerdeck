import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { COMPACTION_TEXT, compactionText } from '../src/lib/format.ts'
import { terminalBlocks } from '../src/components/terminal/blocks.ts'
import { itemHeight, type CellMetrics } from '../src/components/terminal/height.ts'

const m: CellMetrics = { width: 800, ch: 8, line: 18 }

function compaction(
  parentToolUseId: string | null = null,
  id = 'c1',
  over: Partial<Extract<TranscriptItem, { kind: 'compaction' }>> = {},
): TranscriptItem {
  return { kind: 'compaction', id, parentToolUseId, ...over }
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
    expect(items).toContain('compactionText(item)')
    expect(height).toContain('rowH(compactionText(item), m, { extraPx })')
    expect(items).not.toContain(`'${COMPACTION_TEXT}'`)
    expect(height).not.toContain(`'${COMPACTION_TEXT}'`)
  })

  it('says it is working while it works, and what it did once it is done', () => {
    expect(compactionText({ pending: true })).toContain('compacting context')
    // The pending row and the settled one are the same row: same id, so the reducer upserts.
    expect(compactionText({})).toBe(COMPACTION_TEXT)
    expect(compactionText({ preTokens: 148_000, postTokens: 32_000 })).toBe(`${COMPACTION_TEXT} · 148.0k → 32.0k`)
    // An automatic compaction is the one a reader is surprised by, so only that one is named.
    expect(compactionText({ trigger: 'auto', preTokens: 148_000, postTokens: 32_000 })).toContain('automatic')
    expect(compactionText({ trigger: 'manual' })).not.toContain('manual')
    expect(compactionText({ error: 'the model refused' })).toBe('context compaction failed · the model refused')
  })

  it('measures the pending row and the settled one separately', () => {
    expect(itemHeight(compaction(null, 'c1', { pending: true }), m).px).toBe(m.line)
    expect(itemHeight(compaction(null, 'c1', { preTokens: 148_000, postTokens: 32_000 }), m).exact).toBe(true)
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
