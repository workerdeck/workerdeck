import { describe, expect, it } from 'vitest'
import { collapsedResult } from '../src/components/terminal/result-preview.ts'

/**
 * The two budgets, and specifically the blind spot that motivated the second
 * one: an MCP reply is minified JSON, which is *one* line, so a lines-only slice
 * kept every character of it and reported "+0 lines" — the row did not even
 * offer the affordance to open.
 */
describe('collapsedResult', () => {
  it('shows a short result whole and offers nothing', () => {
    const { shown, more } = collapsedResult(['ok', 'done'])
    expect(shown).toEqual(['ok', 'done'])
    expect(more).toBeUndefined()
  })

  it('caps at four lines and counts the rest in lines', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f']
    const { shown, more } = collapsedResult(lines)
    expect(shown).toEqual(['a', 'b', 'c', 'd'])
    expect(more).toBe('… +2 lines')
  })

  it('says “line” singular when exactly one is hidden', () => {
    expect(collapsedResult(['a', 'b', 'c', 'd', 'e']).more).toBe('… +1 line')
  })

  it('truncates a single enormous line and reports characters, not lines', () => {
    const blob = 'x'.repeat(34_000)
    const { shown, more } = collapsedResult([blob])
    expect(shown).toHaveLength(1)
    expect(shown[0]).toHaveLength(401) // 400 kept + the ellipsis
    expect(shown[0]!.endsWith('…')).toBe(true)
    expect(more).toBe(`… +${(34_000 - 400).toLocaleString()} chars`)
  })

  it('stops mid-slice when the character budget runs out before the line budget', () => {
    const lines = ['short', 'y'.repeat(300), 'z'.repeat(300), 'never']
    const { shown, more } = collapsedResult(lines)
    // 'short' (5+1) then 300 more fits; the third would pass 400, so it stops.
    expect(shown).toEqual(['short', lines[1]])
    expect(more).toBe('… +2 lines')
  })

  it('reports characters whenever the cut happened inside a line', () => {
    // The distinction the wording turns on: a truncated *first* line has no
    // hidden lines to count, so "+0 lines" under a visibly cut row would be
    // worse than saying nothing.
    const { more } = collapsedResult(['w'.repeat(500), 'tail'])
    expect(more).toMatch(/chars$/)
  })

  it('handles an empty result without claiming anything is hidden', () => {
    expect(collapsedResult([])).toEqual({ shown: [], more: undefined })
  })
})
