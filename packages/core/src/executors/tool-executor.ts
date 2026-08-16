import type { ToolExecutionBackend } from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'

/**
 * Result of one tool execution, whenever it arrives. `failed` is a normal
 * outcome the agent loop adapts to — not an exception.
 */
export type ToolExecutionResult =
  | { status: 'ok'; output: unknown; logs?: string[] }
  | { status: 'failed'; reason: string; error: string; logs?: string[] }

export type ToolExecutionCall = {
  /** Stable, persisted correlation id. Results are matched and applied by it. */
  executionId: string
  sessionId: string
  /** Tool name, e.g. 'eval_script'. */
  tool: string
  /** Validated tool input. */
  input: unknown
  /** Scoped scratch filesystem for this execution's thread. */
  vfs?: SandboxVfs
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  signal?: AbortSignal
}

/**
 * Dispatch outcome. `settled` carries the result inline; `pending` means it
 * arrives out-of-band later, keyed by executionId — the shape that lets a
 * deferred or remote executor drop in without touching the runner or protocol.
 */
export type ToolExecutionDispatch =
  | { executionId: string; status: 'settled'; result: ToolExecutionResult }
  | { executionId: string; status: 'pending' }

/**
 * The seam between the agent loop and wherever code actually runs — in-process
 * QuickJS, a browser tab over the WS bridge, or a managed sandbox. Backends are
 * interchangeable and selected by context.
 */
/**
 * How an executor will handle one specific call, asked before dispatch so the
 * runner can announce it on `execution_dispatched` (which is emitted before the
 * call goes out, so a bridged request never precedes its own record).
 *
 * Per **call**, not per executor: an executor that routes by tool name can send
 * `eval_script` to the in-process sandbox and a long-running tool to a remote
 * worker, and only the latter should park the session.
 */
export type ToolExecutionProfile = {
  /** Reported on `execution_dispatched`; falls back to the runner's configured default. */
  backend?: ToolExecutionBackend
  /**
   * True when this execution may outlive not just the turn but the live runner:
   * the session parks (state persisted, runner torn down) and the result arrives
   * out of band, keyed by `executionId`.
   */
  deferred?: boolean
  /** Advisory deadline, published as `expiresAt`. For a deferred execution the
   * timer itself belongs to the host — the runner may be gone when it fires. */
  timeoutMs?: number
}

export interface ToolExecutor {
  /** Describe what this call will be: backend, deferredness, deadline. Omitted =
   * an in-band execution on the runner's configured backend. */
  describe?(call: ToolExecutionCall): ToolExecutionProfile
  dispatch(call: ToolExecutionCall): Promise<ToolExecutionDispatch>
}
