import type { ToolExecutionBackend } from '@workerdeck/protocol'
import type { ToolExecutionCall, ToolExecutionDispatch, ToolExecutionProfile, ToolExecutor } from './tool-executor.ts'

export type DeferredDispatch = {
  executionId: string
  sessionId: string
  tool: string
  input: unknown
  vfsSeed?: Record<string, string>
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  expiresAt?: number
}

export type DeferredExecutorOptions = {
  onDispatch: (call: DeferredDispatch) => void | Promise<void>
  timeoutMs?: number
  backend?: ToolExecutionBackend
}

export class DeferredExecutor implements ToolExecutor {
  readonly backend: ToolExecutionBackend
  readonly timeoutMs: number | undefined
  #options: DeferredExecutorOptions

  constructor(options: DeferredExecutorOptions) {
    this.#options = options
    this.backend = options.backend ?? 'remote'
    this.timeoutMs = options.timeoutMs
  }

  describe(): ToolExecutionProfile {
    return { backend: this.backend, deferred: true, timeoutMs: this.timeoutMs }
  }

  async dispatch(call: ToolExecutionCall): Promise<ToolExecutionDispatch> {
    await this.#options.onDispatch({
      executionId: call.executionId,
      sessionId: call.sessionId,
      tool: call.tool,
      input: call.input,
      vfsSeed: call.vfs?.snapshot(),
      limits: call.limits,
      expiresAt: this.timeoutMs === undefined ? undefined : Date.now() + this.timeoutMs,
    })
    return { executionId: call.executionId, status: 'pending' }
  }
}
