import { SUBAGENT_HISTORY, type ContentBlock, type SessionEventBody, type SubagentInfo } from '@workerdeck/protocol'

type TrackedSubagent = SubagentInfo & {
  settledOrder?: number
  background?: 'live' | 'replay'
}

const SPAWNER_NAMES = new Set(['Task', 'Agent'])

export class SubagentTracker {
  #records = new Map<string, TrackedSubagent>()
  #settleCounter = 0

  observe(body: SessionEventBody, ts: number): void {
    switch (body.type) {
      case 'assistant_message': {
        if (body.parentToolUseId != null) {
          const record = this.#recordFor(body.parentToolUseId, ts)
          record.toolCount += toolUseBlocks(body.message.content).length
          return
        }
        for (const block of toolUseBlocks(body.message.content)) {
          if (!SPAWNER_NAMES.has(block.name)) {
            continue
          }
          this.#open(block, ts)
        }
        return
      }
      case 'user_message': {
        if (body.parentToolUseId != null) {
          this.#recordFor(body.parentToolUseId, ts)
          return
        }
        const note = parseTaskNotification(firstText(body.message.content))
        if (note) {
          const record = this.#recordFor(note.toolUseId, ts)
          const status = note.status === 'completed' ? 'done' : 'failed'
          if (record.status !== status) {
            this.#settle(record, status)
          }
          return
        }
        const content = body.message.content
        if (typeof content === 'string') {
          return
        }
        for (const block of content) {
          if (block.type !== 'tool_result') {
            continue
          }
          const result = block as {
            tool_use_id?: unknown
            is_error?: unknown
            content?: unknown
          }
          if (typeof result.tool_use_id !== 'string') {
            continue
          }
          if (result.is_error !== true && isLaunchAck(result.content)) {
            const record = this.#recordFor(result.tool_use_id, ts)
            if (record.background !== 'live') {
              record.background = body.replay === true ? 'replay' : 'live'
            }
            continue
          }
          const record = this.#records.get(result.tool_use_id)
          if (!record) {
            continue
          }
          if (result.is_error !== true && record.background !== undefined) {
            continue
          }
          const status = result.is_error === true ? 'failed' : 'done'
          if (record.status === status) {
            continue
          }
          this.#settle(record, status)
        }
        return
      }
      case 'sdk_event': {
        const p = body.payload as {
          type?: unknown
          subtype?: unknown
          tool_use_id?: unknown
          status?: unknown
          subagent_type?: unknown
          description?: unknown
        }
        if (p.type !== 'system' || typeof p.tool_use_id !== 'string') {
          return
        }
        if (p.subtype === 'task_started') {
          const record = this.#recordFor(p.tool_use_id, ts)
          record.background = 'live'
          record.agentType ??= cleaned(p.subagent_type)
          record.description ??= cleaned(p.description)
          return
        }
        if (p.subtype === 'task_notification') {
          const record = this.#recordFor(p.tool_use_id, ts)
          const status = p.status === 'completed' ? 'done' : 'failed'
          if (record.status !== status) {
            this.#settle(record, status)
          }
          return
        }
        return
      }
      case 'turn_result': {
        this.#sweep(false)
        return
      }
      case 'session_closed': {
        this.#sweep(true)
        return
      }
      case 'status_changed': {
        if (body.status === 'idle') {
          this.#sweep(false)
        } else if (body.status === 'failed' || body.status === 'closed') {
          this.#sweep(true)
        }
        return
      }
      case 'conversation_reset': {
        this.#records.clear()
        return
      }
      default: {
        return
      }
    }
  }

  list(): SubagentInfo[] | undefined {
    if (this.#records.size === 0) {
      return undefined
    }
    const out: SubagentInfo[] = []
    for (const r of this.#records.values()) {
      out.push({
        toolUseId: r.toolUseId,
        agentType: r.agentType,
        description: r.description,
        status: r.status,
        startedAt: r.startedAt,
        toolCount: r.toolCount,
      })
    }
    return out
  }

  #recordFor(toolUseId: string, ts: number): TrackedSubagent {
    let record = this.#records.get(toolUseId)
    if (!record) {
      record = { toolUseId, status: 'running', startedAt: ts, toolCount: 0 }
      this.#records.set(toolUseId, record)
    }
    return record
  }

  #open(block: { id: string; input: unknown }, ts: number): void {
    const record = this.#recordFor(block.id, ts)
    const input = block.input as { subagent_type?: unknown; description?: unknown } | null | undefined
    record.agentType ??= cleaned(input?.subagent_type)
    record.description ??= cleaned(input?.description)
  }

  #sweep(final: boolean): void {
    for (const record of this.#records.values()) {
      if (record.status !== 'running') {
        continue
      }
      if (!final && record.background === 'live') {
        continue
      }
      this.#settle(record, 'failed')
    }
  }

  #settle(record: TrackedSubagent, status: 'done' | 'failed'): void {
    record.status = status
    record.settledOrder = ++this.#settleCounter
    let settled = 0
    for (const r of this.#records.values()) {
      if (r.settledOrder !== undefined) {
        settled++
      }
    }
    while (settled > SUBAGENT_HISTORY) {
      let oldestId: string | undefined
      let oldestOrder = Infinity
      for (const r of this.#records.values()) {
        if (r.settledOrder === undefined || r.settledOrder >= oldestOrder) {
          continue
        }
        oldestId = r.toolUseId
        oldestOrder = r.settledOrder
      }
      if (oldestId === undefined) {
        break
      }
      this.#records.delete(oldestId)
      settled--
    }
  }
}

function isLaunchAck(content: unknown): boolean {
  const text = typeof content === 'string' ? content : firstText(Array.isArray(content) ? content : [])
  return typeof text === 'string' && text.trimStart().startsWith('Async agent launched')
}

function parseTaskNotification(text: string | undefined): { toolUseId: string; status: string } | undefined {
  if (text === undefined || !text.trimStart().startsWith('<task-notification>')) {
    return undefined
  }
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1]
  if (toolUseId === undefined) {
    return undefined
  }
  const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(text)?.[1] ?? ''
  return { toolUseId, status }
}

function firstText(content: string | ContentBlock[] | unknown[]): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null | undefined
    if (b?.type === 'text' && typeof b.text === 'string') {
      return b.text
    }
  }
  return undefined
}

function cleaned(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = value.trim()
  if (text === '') {
    return undefined
  }
  return text.length > 80 ? text.slice(0, 79) + '…' : text
}

function toolUseBlocks(content: string | ContentBlock[]): Array<{ id: string; name: string; input: unknown }> {
  if (typeof content === 'string') {
    return []
  }
  const blocks: Array<{ id: string; name: string; input: unknown }> = []
  for (const block of content) {
    if (block.type !== 'tool_use') {
      continue
    }
    const b = block as { id?: unknown; name?: unknown; input?: unknown }
    if (typeof b.id !== 'string' || typeof b.name !== 'string') {
      continue
    }
    blocks.push({ id: b.id, name: b.name, input: b.input })
  }
  return blocks
}
