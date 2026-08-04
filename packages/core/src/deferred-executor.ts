import type { ToolExecutionBackend } from '@workerdeck/protocol'
import type {
  ToolExecutionCall,
  ToolExecutionDispatch,
  ToolExecutionProfile,
  ToolExecutor,
} from './tool-executor.ts'

/** A dispatched execution, as handed to the backend that will run it. */
export type DeferredDispatch = {
  /** Correlation id. The result is delivered under it — `POST
   * {basePath}/executions/:executionId/result` — and applied idempotently. */
  executionId: string
  sessionId: string
  tool: string
  input: unknown
  /** The session's scratch filesystem at dispatch time, by value. */
  vfsSeed?: Record<string, string>
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /** Epoch ms the host's execution watchdog fires at, when a timeout was configured. */
  expiresAt?: number
}

export type DeferredExecutorOptions = {
  /**
   * Hand the call to whatever actually runs it — enqueue it, POST it to a worker,
   * page a human. Called synchronously during dispatch; throwing fails the
   * execution (the failure reaches the agent as ordinary tool output).
   */
  onDispatch: (call: DeferredDispatch) => void | Promise<void>
  /** How long the result may take before the host's watchdog fails the execution.
   * Unset = no deadline; the execution then relies on the job's parked cap. */
  timeoutMs?: number
  /** Reported on `execution_dispatched`. Default 'remote'. */
  backend?: ToolExecutionBackend
}

/**
 * The executor for work that outlives the session's process residency: dispatch
 * hands the call off and returns `pending` **without holding a promise**, because
 * the runner it would resolve into is about to be torn down. The result can only
 * come back through the host — the execution-result route → `settleExecution` on a
 * rehydrated runner — which is exactly what makes a park durable rather than a
 * long in-memory await.
 *
 * Contrast {@link BrowserBridgeExecutor}, which is also `pending` but keeps its
 * answer in memory for the ~60s the tab has to reply.
 */
export class DeferredExecutor implements ToolExecutor {
  readonly backend: ToolExecutionBackend
  readonly timeoutMs: number | undefined
  #options: DeferredExecutorOptions

  constructor(options: DeferredExecutorOptions) {
    this.#options = options
    this.backend = options.backend ?? 'remote'
    this.timeoutMs = options.timeoutMs
  }

  /** Every call this executor takes is deferred — route only the tools that
   * belong on the remote side to it. */
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
