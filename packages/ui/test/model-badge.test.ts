import { describe, expect, it } from 'vitest'
import { modelBadge } from '@workerdeck/protocol'

describe('modelBadge', () => {
  it.each([
    ['Opus 5.5', 'O', '5.5'],
    ['Haiku 4.5', 'H', '4.5'],
    ['Fable 5', 'F', '5'],
    ['GPT-6.1 Sol', 'S', '6.1'],
    ['GPT-5.5', 'G', '5.5'],
    ['Kimi K3', 'K', '3'],
    ['Gemini 3 Pro', 'P', '3'],
    ['Opus 4.6 (1M context)', 'O', '4.6'],
  ])('%s -> %s %s', (name, letter, version) => {
    expect(modelBadge(name)).toEqual({ letter, version })
  })

  it('keeps an unversioned name to its initial and refuses an empty one', () => {
    expect(modelBadge('mystery')).toEqual({ letter: 'M', version: undefined })
    expect(modelBadge('  ')).toBeUndefined()
  })
})
