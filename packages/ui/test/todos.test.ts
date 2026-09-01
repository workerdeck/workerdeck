import { describe, expect, it } from 'vitest'
import { textLines } from '../src/components/terminal/height.ts'
import { parseTodos, todoLine, todoPreview } from '../src/components/terminal/todos.ts'

function todo(status: 'pending' | 'in_progress' | 'completed', content: string, activeForm?: string) {
  return activeForm === undefined ? { content, status } : { content, status, activeForm }
}

describe('parseTodos', () => {
  it('accepts a well-formed list and keeps its order', () => {
    const todos = parseTodos({ todos: [todo('completed', 'a'), todo('in_progress', 'b'), todo('pending', 'c')] })
    expect(todos).toEqual([
      { status: 'completed', text: 'a' },
      { status: 'in_progress', text: 'b' },
      { status: 'pending', text: 'c' },
    ])
  })

  it('prefers activeForm for the in-progress entry only', () => {
    const todos = parseTodos({
      todos: [todo('in_progress', 'Fix the bug', 'Fixing the bug'), todo('completed', 'Read the file', 'Reading the file')],
    })
    expect(todos?.map((entry) => entry.text)).toEqual(['Fixing the bug', 'Read the file'])
  })

  it('falls back to content when activeForm is blank or missing', () => {
    expect(parseTodos({ todos: [todo('in_progress', 'Fix the bug', '  ')] })?.[0]?.text).toBe('Fix the bug')
    expect(parseTodos({ todos: [todo('in_progress', 'Fix the bug')] })?.[0]?.text).toBe('Fix the bug')
  })

  it('rejects anything that is not a non-empty todos array', () => {
    expect(parseTodos(undefined)).toBeUndefined()
    expect(parseTodos(null)).toBeUndefined()
    expect(parseTodos('todos')).toBeUndefined()
    expect(parseTodos({})).toBeUndefined()
    expect(parseTodos({ todos: 'soon' })).toBeUndefined()
    expect(parseTodos({ todos: [] })).toBeUndefined()
  })

  it('rejects the whole list when one entry is malformed', () => {
    expect(parseTodos({ todos: [todo('pending', 'ok'), 'partial'] })).toBeUndefined()
    expect(parseTodos({ todos: [todo('pending', 'ok'), { content: 'no status' }] })).toBeUndefined()
    expect(parseTodos({ todos: [todo('pending', 'ok'), { content: '', status: 'pending' }] })).toBeUndefined()
    expect(parseTodos({ todos: [todo('pending', 'ok'), { content: 7, status: 'pending' }] })).toBeUndefined()
    expect(parseTodos({ todos: [{ content: 'ok', status: 'paused' }] })).toBeUndefined()
  })
})

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
