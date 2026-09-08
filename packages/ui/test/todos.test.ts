import { describe, expect, it } from 'vitest'
import { textLines } from '../src/components/terminal/height.ts'
import { todoLine, todoPreview } from '../src/components/terminal/todos.ts'

function todo(status: 'pending' | 'in_progress' | 'completed', content: string, activeForm?: string) {
  return activeForm === undefined ? { content, status } : { content, status, activeForm }
}

describe('todoPreview', () => {
  it('answers only TodoWrite', () => {
    const input = { todos: [todo('pending', 'a')] }
    expect(todoPreview('TodoWrite', input)).toBeDefined()
    expect(todoPreview('Write', input)).toBeUndefined()
  })

  it('summarizes completion for the header line', () => {
    const preview = todoPreview('TodoWrite', { todos: [todo('completed', 'a'), todo('completed', 'b'), todo('pending', 'c')] })
    expect(preview?.summary).toBe('2/3 done')
  })

  it('shows a short list whole and offers nothing', () => {
    const preview = todoPreview('TodoWrite', { todos: Array.from({ length: 8 }, (_, i) => todo('pending', `t${i}`)) })
    expect(preview?.shown).toHaveLength(8)
    expect(preview?.more).toBeUndefined()
  })

  it('caps at eight lines and counts the rest', () => {
    const preview = todoPreview('TodoWrite', { todos: Array.from({ length: 11 }, (_, i) => todo('pending', `t${i}`)) })
    expect(preview?.shown).toHaveLength(8)
    expect(preview?.shown[0]?.text).toBe('t0')
    expect(preview?.more).toBe('… +3 more')
  })

  it('falls back to undefined on malformed input rather than a partial checklist', () => {
    expect(todoPreview('TodoWrite', { todos: [todo('pending', 'ok'), { content: 'strea' }] })).toBeUndefined()
  })
})

describe('todoLine', () => {
  it('marks each status with its glyph', () => {
    expect(todoLine({ status: 'pending', text: 'a' })).toBe('☐ a')
    expect(todoLine({ status: 'in_progress', text: 'b' })).toBe('◐ b')
    expect(todoLine({ status: 'completed', text: 'c' })).toBe('☒ c')
  })

  it('uses glyphs the wrap model measures exactly, at one cell each', () => {
    for (const status of ['pending', 'in_progress', 'completed'] as const) {
      const line = todoLine({ status, text: 'ship it' })
      expect(textLines(line, 80)).toEqual({ lines: 1, exact: true })
      expect(textLines(line, line.length - 1).lines).toBe(2)
    }
  })
})
