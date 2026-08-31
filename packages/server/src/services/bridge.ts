import { BrowserBridgeExecutor, type BridgeAnswer, type ToolExecutionResult } from '@workerdeck/core'
import type { ServerFrame, ToolCallRequestFrame } from '@workerdeck/protocol'

type SessionBridge = {
  sockets: Array<(frame: ServerFrame) => void>
  executor: BrowserBridgeExecutor
}

export type BridgeHubOptions = {
  timeoutMs?: number
  onResult?: (sessionId: string, executionId: string, result: ToolExecutionResult) => void
}

export class BridgeHub {
  #sessions = new Map<string, SessionBridge>()
  #options: BridgeHubOptions

  constructor(options: BridgeHubOptions = {}) {
    this.#options = options
  }

  executorFor(sessionId: string): BrowserBridgeExecutor {
    return this.#bridge(sessionId).executor
  }

  attachedCount(sessionId: string): number {
    return this.#sessions.get(sessionId)?.sockets.length ?? 0
  }

  attach(sessionId: string, send: (frame: ServerFrame) => void): () => void {
    const bridge = this.#bridge(sessionId)
    bridge.sockets.push(send)
    return () => {
      const index = bridge.sockets.indexOf(send)
      if (index >= 0) {
        bridge.sockets.splice(index, 1)
      }
    }
  }

  resolve(sessionId: string, executionId: string, answer: BridgeAnswer): boolean {
    return this.#sessions.get(sessionId)?.executor.resolve(executionId, answer) ?? false
  }

  remove(sessionId: string): void {
    const bridge = this.#sessions.get(sessionId)
    if (!bridge) {
      return
    }
    bridge.executor.registry.cancelAll('session_closed', 'the session was closed')
    this.#sessions.delete(sessionId)
  }

  #bridge(sessionId: string): SessionBridge {
    const existing = this.#sessions.get(sessionId)
    if (existing) {
      return existing
    }
    const bridge: SessionBridge = {
      sockets: [],
      executor: new BrowserBridgeExecutor({
        timeoutMs: this.#options.timeoutMs,
        send: (frame: ToolCallRequestFrame) => {
          const target = bridge.sockets[0]
          if (!target) {
            return false
          }
          target(frame)
          return true
        },
        cancel: (executionId, reason) => {
          for (const send of bridge.sockets) {
            send({ type: 'tool_call_canceled', executionId, reason })
          }
        },
        onResult: (executionId, result) => {
          this.#options.onResult?.(sessionId, executionId, result)
        },
      }),
    }
    this.#sessions.set(sessionId, bridge)
    return bridge
  }
}
