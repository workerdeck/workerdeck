import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_HEAD_CHARS } from '@workerdeck/protocol'
import { collapsedResult } from '../src/components/terminal/result-preview.ts'
import { RESULT_PREVIEW_CHARS } from '../src/components/terminal/items.tsx'

describe('the head covers both un-pressed states', () => {
  it('is larger than the open state’s clip', () => {
    expect(TOOL_RESULT_HEAD_CHARS).toBeGreaterThan(RESULT_PREVIEW_CHARS)
  })

  it('is larger than anything the collapsed state can show', () => {
    // The collapsed budget is private to `result-preview`, so measure it rather than restate it.
    const shown = collapsedResult(['y'.repeat(100_000)]).shown.join('\n')
    expect(TOOL_RESULT_HEAD_CHARS).toBeGreaterThan(shown.length)
  })
})

describe('collapsedResult with a truncated head', () => {
  it('counts what is MISSING, not what it holds', () => {
    const head = 'z'.repeat(TOOL_RESULT_HEAD_CHARS)
    const { more } = collapsedResult([head], 641_003)
    expect(more).toBe(`… +${(641_003 - 400).toLocaleString()} chars`)
  })

  it('still offers the affordance when the head fit the line budget', () => {
    const { more } = collapsedResult(['a', 'b', 'c', 'd'], 600_000)
    expect(more).toMatch(/^… \+\d[\d,]* chars$/)
  })

  it('is unchanged for a whole result', () => {
    expect(collapsedResult(['a', 'b', 'c', 'd', 'e'])).toEqual(collapsedResult(['a', 'b', 'c', 'd', 'e'], undefined))
  })
})
