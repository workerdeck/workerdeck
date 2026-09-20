import {
  CHECKLIST_TEXT_MAX,
  parseTodoWriteInput,
  type ChecklistItem,
  type ChecklistStatus,
  type ContentBlock,
  type SessionEventBody,
} from '@workerdeck/protocol'

const TODO_WRITE = 'TodoWrite'
const TASK_CREATE = 'TaskCreate'
const TASK_UPDATE = 'TaskUpdate'
const CREATED_RE = /Task #(\S+) created successfully/

type TaskEntry = { subject: string; activeForm?: string; status: ChecklistStatus }
type TaskDraft = { subject: string; activeForm?: string }
type TaskUpdate = { taskId: string; status?: ChecklistStatus | 'deleted'; subject?: string; activeForm?: string }

function clamp(items: ChecklistItem[]): ChecklistItem[] {
  return items.map((item) => (item.text.length > CHECKLIST_TEXT_MAX ? { ...item, text: item.text.slice(0, CHECKLIST_TEXT_MAX) } : item))
}

export function checklistFromBody(body: SessionEventBody): ChecklistItem[] | undefined {
  if (body.type !== 'assistant_message' || body.parentToolUseId != null) {
    return undefined
  }
  const content = body.message.content
  if (typeof content === 'string') {
    return undefined
  }
  let items: ChecklistItem[] | undefined
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_use' || block.name !== TODO_WRITE) {
      continue
    }
    items = parseTodoWriteInput(block.input) ?? items
  }
  return items === undefined ? undefined : clamp(items)
}

export function checklistFromPlan(plan: unknown): ChecklistItem[] | undefined {
  if (!Array.isArray(plan)) {
    return undefined
  }
  const out: ChecklistItem[] = []
  for (const value of plan) {
    if (typeof value !== 'object' || value === null) {
      return undefined
    }
    const raw = value as { step?: unknown; status?: unknown }
    const text = typeof raw.step === 'string' ? raw.step.trim() : ''
    if (text === '') {
      return undefined
    }
    if (raw.status === 'pending') {
      out.push({ text, status: 'pending' })
    } else if (raw.status === 'inProgress' || raw.status === 'in_progress') {
      out.push({ text, status: 'in_progress' })
    } else if (raw.status === 'completed') {
      out.push({ text, status: 'completed' })
    } else {
      return undefined
    }
  }
  return clamp(out)
}

export function sameChecklist(a: readonly ChecklistItem[] | undefined, b: readonly ChecklistItem[]): boolean {
  const left = a ?? []
  if (left.length !== b.length) {
    return false
  }
  return left.every((item, i) => item.text === b[i]!.text && item.status === b[i]!.status)
}

function rootBlocks(body: SessionEventBody, type: 'assistant_message' | 'user_message'): ContentBlock[] {
  if (body.type !== type || body.parentToolUseId != null || typeof body.message.content === 'string') {
    return []
  }
  return body.message.content as ContentBlock[]
}

function taskDraft(input: unknown): TaskDraft | undefined {
  const raw = input as { subject?: unknown; activeForm?: unknown } | null
  const subject = typeof raw?.subject === 'string' ? raw.subject.trim() : ''
  if (subject === '') {
    return undefined
  }
  const activeForm = typeof raw?.activeForm === 'string' ? raw.activeForm.trim() : ''
  return activeForm === '' ? { subject } : { subject, activeForm }
}

function taskUpdate(input: unknown): TaskUpdate | undefined {
  const raw = input as { taskId?: unknown; status?: unknown; subject?: unknown; activeForm?: unknown } | null
  if (typeof raw?.taskId !== 'string') {
    return undefined
  }
  const out: TaskUpdate = { taskId: raw.taskId }
  if (raw.status === 'pending' || raw.status === 'in_progress' || raw.status === 'completed' || raw.status === 'deleted') {
    out.status = raw.status
  }
  if (typeof raw.subject === 'string' && raw.subject.trim() !== '') {
    out.subject = raw.subject.trim()
  }
  if (typeof raw.activeForm === 'string' && raw.activeForm.trim() !== '') {
    out.activeForm = raw.activeForm.trim()
  }
  return out
}

function resultText(block: ContentBlock): string {
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content.map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
  }
  return ''
}

// The CLI's TaskCreate/TaskUpdate checklist is incremental and the id is minted in the result, so the
// fold is stateful: a create is pending until its tool_result names the id, an update applies to a task
// already known, and a TodoWrite anywhere hands the list back to the whole-list fold.
export class TaskChecklist {
  #pending = new Map<string, TaskDraft>()
  #tasks = new Map<string, TaskEntry>()

  reset(): void {
    this.#pending.clear()
    this.#tasks.clear()
  }

  observe(body: SessionEventBody): ChecklistItem[] | undefined {
    let changed = false
    for (const block of rootBlocks(body, 'assistant_message')) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (block.name === TASK_CREATE) {
        const draft = taskDraft(block.input)
        if (draft && typeof block.id === 'string') {
          this.#pending.set(block.id, draft)
        }
      } else if (block.name === TASK_UPDATE) {
        changed = this.#apply(taskUpdate(block.input)) || changed
      }
    }
    for (const block of rootBlocks(body, 'user_message')) {
      if (block.type !== 'tool_result') {
        continue
      }
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id
      const draft = typeof toolUseId === 'string' ? this.#pending.get(toolUseId) : undefined
      if (!draft || typeof toolUseId !== 'string') {
        continue
      }
      this.#pending.delete(toolUseId)
      const id = CREATED_RE.exec(resultText(block))?.[1]
      if (id && !this.#tasks.has(id)) {
        this.#tasks.set(id, { ...draft, status: 'pending' })
        changed = true
      }
    }
    return changed ? this.list() : undefined
  }

  list(): ChecklistItem[] {
    const out: ChecklistItem[] = []
    for (const task of this.#tasks.values()) {
      out.push({ status: task.status, text: task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject })
    }
    return clamp(out)
  }

  #apply(update: TaskUpdate | undefined): boolean {
    const task = update ? this.#tasks.get(update.taskId) : undefined
    if (!update || !task) {
      return false
    }
    if (update.status === 'deleted') {
      this.#tasks.delete(update.taskId)
      return true
    }
    if (update.status) {
      task.status = update.status
    }
    if (update.subject) {
      task.subject = update.subject
    }
    if (update.activeForm) {
      task.activeForm = update.activeForm
    }
    return true
  }
}
