import { describe, expect, it } from 'vitest'
import { statusLine } from '../src/components/agent/SessionItem.tsx'

describe('statusLine', () => {
  it('draws the emoji before the text, and nothing without a label', () => {
    expect(statusLine({ text: 'waiting on CI', emoji: '⏳', setAt: 1 })).toBe('⏳ waiting on CI')
    expect(statusLine({ text: 'done', setAt: 1 })).toBe('done')
    expect(statusLine(undefined)).toBeUndefined()
  })
})
