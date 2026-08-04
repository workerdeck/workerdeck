import type { ToolCallRequestFrame, ToolExecutionOutput } from '@workerdeck/protocol'
import { PendingRequestRegistry, type PendingOutcome } from './pending-registry.ts'
import type {
  ToolExecutionCall,
  ToolExecutionDispatch,
  ToolExecutionResult,
  ToolExecutor,
} from './tool-executor.ts'

/** Answer a bridged call, as delivered by the client over the wire. */
export type BridgeAnswer =
  | { output: ToolExecutionOutput; logs?: string[] }
  | { reason: string; error: string; logs?: string[] }

export type BrowserBridgeExecutorOptions = {
  /**
   * Put a `tool_call_request` on the wire to the attached client. Returning
   * false means nobody is attached — the execution fails immediately rather
   * than hanging until its deadline.
   */
  send: (frame: ToolCallRequestFrame) => boolean
  /** Tell the client to abandon a call the server gave up on. */
  cancel?: (executionId: string, reason: string) => void
  /** How long to wait for the client before failing the execution. Default 60000. */
  timeoutMs?: number
  /**
   * Called once per dispatched execution when it reaches a terminal result,
   * however it got there (client answer, timeout, abort, no client). This is
   * the wire back into the agent loop — the host feeds it to the runner's
   * `resolveToolCall`. A timeout arrives here as a failed result, not silence.
   */
  onResult?: (executionId: string, result: ToolExecutionResult) => void
  /** Share the session's registry so approvals, bridged calls, and deferred
   * executions live in one table. Omit to get a private one. */
  registry?: PendingRequestRegistry
}

/**
 * Executes tool calls in the attached client's own sandbox. The first backend
 * that genuinely returns `pending`: dispatch puts a request on the wire and
 * returns, and the result arrives later through {@link resolve}.
 *
 * Data locality is the point — documents can stay in the browser and never
 * reach the server. The tradeoff is trust: whatever comes back is untrusted
 * input, fine for the user's own data but never a source for authoritative
 * server state (that is why MCP and secret-bearing tools are never bridged).
 */
export class BrowserBridgeExecutor implements ToolExecutor {
  readonly registry: PendingRequestRegistry
  #options: BrowserBridgeExecutorOptions
  /** Results that arrive before dispatch registers them (fast client, slow
   * bookkeeping) would otherwise be dropped — hold them briefly. */
  #early = new Map<string, BridgeAnswer>()

  constructor(options: BrowserBridgeExecutorOptions) {
    this.#options = options
    this.registry = options.registry ?? new PendingRequestRegistry()
  }

  async dispatch(call: ToolExecutionCall): Promise<ToolExecutionDispatch> {
    const timeoutMs = call.limits?.timeoutMs ?? this.#options.timeoutMs ?? 60_000
    const expiresAt = Date.now() + timeoutMs
    const frame: ToolCallRequestFrame = {
      type: 'tool_call_request',
      executionId: call.executionId,
      toolName: call.tool,
      input: call.input,
      vfsSeed: call.vfs?.snapshot(),
      limits: call.limits,
      expiresAt,
    }

    const settled = this.registry.register<BridgeAnswer>({
      id: call.executionId,
      kind: 'tool_call',
      timeoutMs,
      meta: { toolName: call.tool, sessionId: call.sessionId },
    })

    if (!this.#options.send(frame)) {
      this.registry.fail(call.executionId, 'no_client', 'no client is attached to execute this call')
      // Nobody can ever answer this one — settle it inline rather than making
      // the caller wait out a deadline for a result that cannot come.
      return {
        executionId: call.executionId,
        status: 'settled',
        result: toExecutionResult(await settled),
      }
    }

    // Drain an answer that beat the registration.
    const early = this.#early.get(call.executionId)
    if (early) {
      this.#early.delete(call.executionId)
      this.#applyAnswer(call.executionId, early)
    }

    // Only fail it here — the settle handler below owns sending the cancel, so
    // every non-client failure notifies the client exactly once.
    const onAbort = () => {
      this.registry.fail(call.executionId, 'aborted', 'the turn was interrupted')
    }
    call.signal?.addEventListener('abort', onAbort, { once: true })
    void settled.then((outcome) => {
      call.signal?.removeEventListener('abort', onAbort)
      // Let the client stop working on anything it can no longer answer.
      if (!outcome.ok && outcome.settledBy !== 'client') {
        this.#options.cancel?.(call.executionId, outcome.reason)
      }
      this.#options.onResult?.(call.executionId, toExecutionResult(outcome))
    })

    return { executionId: call.executionId, status: 'pending' }
  }

  /**
   * Apply a client's answer. Returns false when the id is unknown or already
   * settled — a late result after a timeout must not re-open a settled call.
   */
  resolve(executionId: string, answer: BridgeAnswer): boolean {
    if (!this.registry.has(executionId)) {
      // Racing a dispatch still in flight; hold it briefly for the drain above.
      this.#early.set(executionId, answer)
      setTimeout(() => this.#early.delete(executionId), 5000).unref?.()
      return false
    }
    return this.#applyAnswer(executionId, answer)
  }

  #applyAnswer(executionId: string, answer: BridgeAnswer): boolean {
    return 'output' in answer
      ? this.registry.settle(executionId, answer, 'client')
      : this.registry.fail(executionId, answer.reason, answer.error, 'client')
  }
}

/** Map a registry outcome onto the executor's result contract. */
export function toExecutionResult(outcome: PendingOutcome<BridgeAnswer>): ToolExecutionResult {
  if (outcome.ok && 'output' in outcome.value) {
    const { output, logs } = outcome.value
    return { status: 'ok', output: output.type === 'text' ? output.value : output.value, logs }
  }
  if (outcome.ok) {
    const failure = outcome.value as { reason: string; error: string; logs?: string[] }
    return { status: 'failed', reason: failure.reason, error: failure.error, logs: failure.logs }
  }
  return { status: 'failed', reason: outcome.reason, error: outcome.error }
}
