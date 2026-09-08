import type { ChecklistItem, ChecklistStatus } from '@workerdeck/protocol'
import { parseTodoWriteInput } from '@workerdeck/protocol'

export type TodoStatus = ChecklistStatus

export type TodoEntry = ChecklistItem

export type TodoPreview = { summary: string; shown: TodoEntry[]; more?: string }

const PREVIEW_TODOS = 8

const GLYPH: Record<TodoStatus, string> = { pending: '☐', in_progress: '◐', completed: '☒' }

export function todoPreview(name: string, input: unknown): TodoPreview | undefined {
  if (name !== 'TodoWrite') {
    return undefined
  }
  const todos = parseTodoWriteInput(input)
  if (todos === undefined || todos.length === 0) {
    return undefined
  }
  const done = todos.reduce((n, todo) => n + (todo.status === 'completed' ? 1 : 0), 0)
  const shown = todos.slice(0, PREVIEW_TODOS)
  const hidden = todos.length - shown.length
  return {
    summary: `${done}/${todos.length} done`,
    shown,
    more: hidden > 0 ? `… +${hidden} more` : undefined,
  }
}

// Height and render both draw this exact string — `toolRowHeight` counts what `TerminalTodos` paints.
export function todoLine(todo: TodoEntry): string {
  return `${GLYPH[todo.status]} ${todo.text}`
}
