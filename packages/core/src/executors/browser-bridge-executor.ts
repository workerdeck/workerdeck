import type { ToolCallRequestFrame, ToolExecutionOutput } from '@workerdeck/protocol'
import { PendingRequestRegistry, type PendingOutcome } from '../lib/pending-registry.ts'
import type { ToolExecutionCall, ToolExecutionDispatch, ToolExecutionResult, ToolExecutor } from './tool-executor.ts'

export type BridgeAnswer = { output: ToolExecutionOutput; logs?: string[] } | { reason: string; error: string; logs?: string[] }

export type BrowserBridgeExecutorOptions = {
  send: (frame: ToolCallRequestFrame) => boolean
  cancel?: (executionId: string, reason: string) => void
  timeoutMs?: number
  onResult?: (executionId: string, result: ToolExecutionResult) => void
  registry?: PendingRequestRegistry
}

export class BrowserBridgeExecutor implements ToolExecutor {
  readonly registry: PendingRequestRegistry
  #options: BrowserBridgeExecutorOptions
  // A client answer can beat its own registration; held briefly here or it is dropped.
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
      return {
        executionId: call.executionId,
        status: 'settled',
        result: toExecutionResult(await settled),
      }
    }

    const early = this.#early.get(call.executionId)
    if (early) {
      this.#early.delete(call.executionId)
      this.#applyAnswer(call.executionId, early)
    }

    // Only fail here: the settle handler owns the cancel, so a non-client failure notifies
    // the client exactly once.
    const onAbort = () => {
      this.registry.fail(call.executionId, 'aborted', 'the turn was interrupted')
    }
    call.signal?.addEventListener('abort', onAbort, { once: true })
    void settled.then((outcome) => {
      call.signal?.removeEventListener('abort', onAbort)
      if (!outcome.ok && outcome.settledBy !== 'client') {
        this.#options.cancel?.(call.executionId, outcome.reason)
      }
      this.#options.onResult?.(call.executionId, toExecutionResult(outcome))
    })

    return { executionId: call.executionId, status: 'pending' }
  }

  resolve(executionId: string, answer: BridgeAnswer): boolean {
    if (!this.registry.has(executionId)) {
      // Racing a dispatch still in flight; hold it for the drain above.
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

export function toExecutionResult(outcome: PendingOutcome<BridgeAnswer>): ToolExecutionResult {
  if (outcome.ok && 'output' in outcome.value) {
    const { output, logs } = outcome.value
    return { status: 'ok', output: output.value, logs }
  }
  if (outcome.ok) {
    const failure = outcome.value as { reason: string; error: string; logs?: string[] }
    return { status: 'failed', reason: failure.reason, error: failure.error, logs: failure.logs }
  }
  return { status: 'failed', reason: outcome.reason, error: outcome.error }
}
