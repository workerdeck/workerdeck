import type { SubagentInfo } from '@workerdeck/protocol'
import { SettledHistory } from '../../lib/settled-history.ts'

export class CodexAgentTracker {
  #byThread = new Map<string, CodexAgent>()
  #settled = new SettledHistory<string>()

  get(agentThreadId: string): CodexAgent | undefined {
    return this.#byThread.get(agentThreadId)
  }

  open(agentThreadId: string, toolUseId: string, agentType: string | undefined, ts: number): CodexAgent {
    let record = this.#byThread.get(agentThreadId)
    if (!record) {
      record = {
        agentThreadId,
        toolUseId,
        scope: { nonce: toolUseId, toolUseEmitted: new Set(), sectionIndex: new Map() },
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
    this.#settled.forget(record.agentThreadId)
  }

  #settle(record: CodexAgent, status: 'done' | 'failed'): void {
    record.status = status
    for (const evicted of this.#settled.settle(record.agentThreadId)) {
      this.#byThread.delete(evicted)
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
    this.#settled.clear()
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
        isAgent: true,
        status: r.status,
        startedAt: r.startedAt,
        toolCount: r.toolCount,
      })
    }
    return out
  }
}

export type ItemScope = {
  nonce: string
  toolUseEmitted: Set<string>
  sectionIndex: Map<string, number>
}

export type CodexAgent = {
  agentThreadId: string
  toolUseId: string
  // The child's items resolve through its own scope, so they keep flowing between root turns.
  scope: ItemScope
  agentType?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  toolCount: number
  // `imageGeneration` re-emits its card with the finished input, so ids are counted once.
  counted: Set<string>
  anchored?: boolean
}
