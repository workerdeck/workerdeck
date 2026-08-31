import { describe, expect, it } from 'vitest'
import { collapsedResult } from '../src/components/terminal/result-preview.ts'

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
    expect(shown).toEqual(['short', lines[1]])
    expect(more).toBe('… +2 lines')
  })

  it('reports characters whenever the cut happened inside a line', () => {
    const { more } = collapsedResult(['w'.repeat(500), 'tail'])
    expect(more).toMatch(/chars$/)
  })

  it('handles an empty result without claiming anything is hidden', () => {
    expect(collapsedResult([])).toEqual({ shown: [], more: undefined })
  })
})
