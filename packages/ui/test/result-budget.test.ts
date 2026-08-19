/**
 * The relationship that collapses this whole feature to one press.
 *
 * `TOOL_RESULT_HEAD_CHARS` is not a number picked for comfort: it is chosen
 * **against these two budgets**, so that a truncated row's collapsed and open
 * states are byte-identical to what an untruncated attach would have drawn, and
 * only the uncapped "show everything" press ever costs a fetch. Lower the head
 * below the open budget and the open state silently clips with no marker — the
 * one failure this design must not have — which is why it is asserted here
 * rather than trusted to a comment.
 */
import { describe, expect, it } from 'vitest'
import { TOOL_RESULT_HEAD_CHARS } from '@workerdeck/protocol'
import { collapsedResult } from '../src/components/terminal/result-preview.ts'
import { RESULT_PREVIEW_CHARS } from '../src/components/terminal/items.tsx'

describe('the head covers both un-pressed states', () => {
  it('is larger than the open state’s clip', () => {
    expect(TOOL_RESULT_HEAD_CHARS).toBeGreaterThan(RESULT_PREVIEW_CHARS)
  })

  it('is larger than anything the collapsed state can show', () => {
    // The collapsed budget is private to `result-preview`, so measure it rather
    // than restate it: the longest `shown` it will ever produce.
    const shown = collapsedResult(['y'.repeat(100_000)]).shown.join('\n')
    expect(TOOL_RESULT_HEAD_CHARS).toBeGreaterThan(shown.length)
  })
})

describe('collapsedResult with a truncated head', () => {
  it('counts what is MISSING, not what it holds', () => {
    const head = 'z'.repeat(TOOL_RESULT_HEAD_CHARS)
    const { more } = collapsedResult([head], 641_003)
    // Not "+7,600 chars" — the head is not the result, and the wrong string is a
    // different pixel height.
    expect(more).toBe(`… +${(641_003 - 400).toLocaleString()} chars`)
  })

  it('still offers the affordance when the head fit the line budget', () => {
    // Four short lines, and 600,000 characters that never arrived: a row that
    // said nothing here would claim to be showing everything.
    const { more } = collapsedResult(['a', 'b', 'c', 'd'], 600_000)
    expect(more).toMatch(/^… \+\d[\d,]* chars$/)
  })

  it('is unchanged for a whole result', () => {
    expect(collapsedResult(['a', 'b', 'c', 'd', 'e'])).toEqual(
      collapsedResult(['a', 'b', 'c', 'd', 'e'], undefined),
    )
  })
})
