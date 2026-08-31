import { SUBAGENT_HISTORY, type SubagentInfo } from '@workerdeck/protocol'

export class CodexAgentTracker {
  #byThread = new Map<string, CodexAgent>()
  #settleCounter = 0

  get(agentThreadId: string): CodexAgent | undefined {
    return this.#byThread.get(agentThreadId)
  }

  open(agentThreadId: string, toolUseId: string, agentType: string | undefined, ts: number): CodexAgent {
    let record = this.#byThread.get(agentThreadId)
    if (!record) {
      record = {
        agentThreadId,
        toolUseId,
        status: 'running',
        startedAt: ts,
        toolCount: 0,
        counted: new Set(),
      }
      this.#byThread.set(agentThreadId, record)
    }
    record.agentType ??= agentType
    return record
  }

  revive(record: CodexAgent): void {
    record.status = 'running'
    record.settledOrder = undefined
  }

  #settle(record: CodexAgent, status: 'done' | 'failed'): void {
    record.status = status
    record.settledOrder = ++this.#settleCounter
    let settled = 0
    for (const r of this.#byThread.values()) {
      if (r.settledOrder !== undefined) {
        settled++
      }
    }
    while (settled > SUBAGENT_HISTORY) {
      let oldest: CodexAgent | undefined
      for (const r of this.#byThread.values()) {
        if (r.settledOrder === undefined) {
          continue
        }
        if (!oldest || r.settledOrder < oldest.settledOrder!) {
          oldest = r
        }
      }
      if (!oldest) {
        break
      }
      this.#byThread.delete(oldest.agentThreadId)
      settled--
    }
  }

  settle(record: CodexAgent, status: 'done' | 'failed'): void {
    if (record.status === status) {
      return
    }
    this.#settle(record, status)
  }

  sweep(): void {
    for (const record of this.#byThread.values()) {
      if (record.status === 'running') {
        this.#settle(record, 'failed')
      }
    }
  }

  forget(): void {
    this.#byThread.clear()
  }

  threadIds(): string[] {
    return Array.from(this.#byThread.keys())
  }

  list(): SubagentInfo[] | undefined {
    if (this.#byThread.size === 0) {
      return undefined
    }
    const out: SubagentInfo[] = []
    for (const r of this.#byThread.values()) {
      out.push({
        toolUseId: r.toolUseId,
        agentType: r.agentType,
        status: r.status,
        startedAt: r.startedAt,
        toolCount: r.toolCount,
      })
    }
    return out
  }
}

export type CodexAgent = {
  agentThreadId: string
  toolUseId: string
  agentType?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  toolCount: number
  // `imageGeneration` re-emits its card with the finished input, so ids are counted once.
  counted: Set<string>
  anchored?: boolean
  // Insertion order cannot stand in: a slow early agent settles after a fast late one.
  settledOrder?: number
}
