export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoEntry = { status: TodoStatus; text: string }

export type TodoPreview = { summary: string; shown: TodoEntry[]; more?: string }

const PREVIEW_TODOS = 8

const GLYPH: Record<TodoStatus, string> = { pending: '☐', in_progress: '◐', completed: '☒' }

function todoEntry(value: unknown): TodoEntry | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const raw = value as { content?: unknown; status?: unknown; activeForm?: unknown }
  const status = raw.status
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
    return undefined
  }
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (content === '') {
    return undefined
  }
  const active = typeof raw.activeForm === 'string' ? raw.activeForm.trim() : ''
  return { status, text: status === 'in_progress' && active !== '' ? active : content }
}

// Whole-or-nothing: a malformed entry (streaming, partial input) falls back to the generic preview rather than a half-drawn checklist.
export function parseTodos(input: unknown): TodoEntry[] | undefined {
  const todos = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos) || todos.length === 0) {
    return undefined
  }
  const out: TodoEntry[] = []
  for (const value of todos) {
    const entry = todoEntry(value)
    if (entry === undefined) {
      return undefined
    }
    out.push(entry)
  }
  return out
}

export function todoPreview(name: string, input: unknown): TodoPreview | undefined {
  if (name !== 'TodoWrite') {
    return undefined
  }
  const todos = parseTodos(input)
  if (todos === undefined) {
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
