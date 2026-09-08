import { CHECKLIST_TEXT_MAX, parseTodoWriteInput, type ChecklistItem, type ContentBlock, type SessionEventBody } from '@workerdeck/protocol'

const TODO_WRITE = 'TodoWrite'

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
