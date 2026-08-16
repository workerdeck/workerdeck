import { BrowserBridgeExecutor, type BridgeAnswer, type ToolExecutionResult } from '@workerdeck/core'
import type { ServerFrame, ToolCallRequestFrame } from '@workerdeck/protocol'

type SessionBridge = {
  /** Every client currently attached to this session, in attach order. */
  sockets: Array<(frame: ServerFrame) => void>
  executor: BrowserBridgeExecutor
}

export type BridgeHubOptions = {
  /** How long a bridged call may stay unanswered before it fails. Default 60000. */
  timeoutMs?: number
  /** Called when a bridged execution reaches a terminal result — the host feeds
   * it back into the runner's loop. */
  onResult?: (sessionId: string, executionId: string, result: ToolExecutionResult) => void
}

/**
 * Routes tool executions between a session and the browser tabs attached to it.
 *
 * A session may have several clients attached (dashboard plus embedded panel);
 * the bridge asks the **first attached** one, which is the closest thing to "the
 * client driving this session". If none is attached, dispatch fails fast rather
 * than hanging — an autonomous job simply never bridges, it uses the server
 * executor instead.
 */
export class BridgeHub {
  #sessions = new Map<string, SessionBridge>()
  #options: BridgeHubOptions

  constructor(options: BridgeHubOptions = {}) {
    this.#options = options
  }

  /** The executor to hand a runner for this session. Created on first use and
   * reused, so results routed back always reach the same pending table. */
  executorFor(sessionId: string): BrowserBridgeExecutor {
    return this.#bridge(sessionId).executor
  }

  /** How many clients are watching this session. Parking consults it: a session
   * someone is watching stays live. */
  attachedCount(sessionId: string): number {
    return this.#sessions.get(sessionId)?.sockets.length ?? 0
  }

  /** Register an attached client. Returns a detach function. */
  attach(sessionId: string, send: (frame: ServerFrame) => void): () => void {
    const bridge = this.#bridge(sessionId)
    bridge.sockets.push(send)
    return () => {
      const index = bridge.sockets.indexOf(send)
      if (index >= 0) bridge.sockets.splice(index, 1)
    }
  }

  /**
   * Deliver a client's answer to a bridged call. Returns false when the id is
   * unknown or already settled — late and duplicate answers are ignored.
   */
  resolve(sessionId: string, executionId: string, answer: BridgeAnswer): boolean {
    return this.#sessions.get(sessionId)?.executor.resolve(executionId, answer) ?? false
  }

  /** Drop a session's bridge, failing anything still in flight. */
  remove(sessionId: string): void {
    const bridge = this.#sessions.get(sessionId)
    if (!bridge) return
    bridge.executor.registry.cancelAll('session_closed', 'the session was closed')
    this.#sessions.delete(sessionId)
  }

  #bridge(sessionId: string): SessionBridge {
    const existing = this.#sessions.get(sessionId)
    if (existing) return existing
    const bridge: SessionBridge = {
      sockets: [],
      executor: new BrowserBridgeExecutor({
        timeoutMs: this.#options.timeoutMs,
        send: (frame: ToolCallRequestFrame) => {
          const target = bridge.sockets[0]
          if (!target) return false
          target(frame)
          return true
        },
        cancel: (executionId, reason) => {
          for (const send of bridge.sockets) send({ type: 'tool_call_canceled', executionId, reason })
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
