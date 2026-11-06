import { describe, expect, it } from 'vitest'
import { goalBudgetChange } from '@workerdeck/protocol'

describe('goalBudgetChange', () => {
  it('leaves an untouched budget alone, so a change made elsewhere stands', () => {
    expect(goalBudgetChange('100', 100)).toBeUndefined()
    expect(goalBudgetChange(' 100 ', 100)).toBeUndefined()
    expect(goalBudgetChange('', undefined)).toBeUndefined()
  })

  it('removes a shown budget the person emptied, and sets a changed one', () => {
    expect(goalBudgetChange('', 100)).toBeNull()
    expect(goalBudgetChange('250', 100)).toBe(250)
    expect(goalBudgetChange('250', undefined)).toBe(250)
  })
})
