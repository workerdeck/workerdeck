import type { ChecklistItem, ChecklistStatus, SessionInfo } from './index.ts'
import { isAgentRecord } from './session-list.ts'

export type SessionTaskState = 'pending' | 'running' | 'done' | 'failed'

export type SessionTaskSource = 'checklist' | 'spawn'

export type SessionTask = {
  key: string
  label: string
  source: SessionTaskSource
  state: SessionTaskState
  detail?: string
  toolUseId?: string
}

export type TaskSummary = { total: number; done: number; running: number; failed: number }

function checklistEntry(value: unknown): ChecklistItem | undefined {
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

// Whole-or-nothing: a malformed entry (streaming, partial input) yields undefined rather than a half-read list.
// A well-formed empty list is a clear, and answers `[]`.
export function parseTodoWriteInput(input: unknown): ChecklistItem[] | undefined {
  const todos = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos)) {
    return undefined
  }
  const out: ChecklistItem[] = []
  for (const value of todos) {
    const entry = checklistEntry(value)
    if (entry === undefined) {
      return undefined
    }
    out.push(entry)
  }
  return out
}

function checklistState(status: ChecklistStatus): SessionTaskState {
  switch (status) {
    case 'in_progress': {
      return 'running'
    }
    case 'completed': {
      return 'done'
    }
    default: {
      return 'pending'
    }
  }
}

export function sessionTasks(info: Pick<SessionInfo, 'checklist' | 'subagents'>): SessionTask[] {
  const checklist = (info.checklist ?? []).map((item, index) => ({
    key: `checklist:${index}`,
    label: item.text,
    source: 'checklist' as const,
    state: checklistState(item.status),
  }))
  const spawns = (info.subagents ?? [])
    .filter((sub) => !isAgentRecord(sub))
    .map((sub) => ({
      key: `spawn:${sub.toolUseId}`,
      label: sub.description?.trim() || 'Task',
      source: 'spawn' as const,
      state: sub.status,
      detail: sub.toolCount > 0 ? String(sub.toolCount) : undefined,
      toolUseId: sub.toolUseId,
    }))
  return [...checklist, ...spawns]
}

export function taskSummary(tasks: readonly SessionTask[]): TaskSummary {
  let done = 0
  let running = 0
  let failed = 0
  for (const task of tasks) {
    if (task.state === 'done') {
      done += 1
    } else if (task.state === 'running') {
      running += 1
    } else if (task.state === 'failed') {
      failed += 1
    }
  }
  return { total: tasks.length, done, running, failed }
}

export function taskCountLabel(summary: TaskSummary): string | undefined {
  return summary.total === 0 ? undefined : `${summary.done}/${summary.total}`
}

export function visibleTasks(tasks: readonly SessionTask[], showCompleted: boolean): SessionTask[] {
  return showCompleted ? [...tasks] : tasks.filter((task) => task.state !== 'done')
}
