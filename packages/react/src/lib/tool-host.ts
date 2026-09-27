import type { SessionHandle } from '@workerdeck/client'
import { errorMessage, type ToolCallRequestFrame } from '@workerdeck/protocol'
import type { RunScriptResult, SandboxEngine, SandboxVfs } from '@workerdeck/sandbox'

export type ToolHostExecution = {
  executionId: string
  toolName: string
  status: 'running' | 'settled' | 'failed' | 'canceled'
  reason?: string
  startedAt: number
  endedAt?: number
}

export type ToolHostRunner = (request: {
  script: string
  vfs: SandboxVfs
  timeoutMs: number
  memoryLimitBytes: number
  signal: AbortSignal
}) => Promise<RunScriptResult>

export type ClientToolResult = { value: unknown } | { error: string; reason?: string }

export type ClientToolHandler = (
  input: unknown,
  context: { executionId: string; signal: AbortSignal },
) => ClientToolResult | Promise<ClientToolResult>

export type ToolCallHostOptions = {
  tools?: string[]
  clientTools?: Record<string, ClientToolHandler>
  timeoutMs?: number
  memoryLimitBytes?: number
  loadEngine?: () => Promise<SandboxEngine>
  // The guest deadline preempts the interpreter only on the thread it runs on; a Web Worker is the way off this one.
  execute?: ToolHostRunner
  fetchText?: (url: string) => Promise<string>
  onExecution?: (execution: ToolHostExecution) => void
}

type Work = (signal: AbortSignal) => Promise<Outcome>

type Outcome = { ok: true; value: unknown; logs?: string[] } | { ok: false; reason: string; error: string; logs?: string[] }

export function createToolCallHost(handle: SessionHandle, options: ToolCallHostOptions = {}): { dispose: () => void } {
  const inFlight = new Map<string, AbortController>()
  let enginePromise: Promise<SandboxEngine> | undefined
  let disposed = false

  const track = (execution: ToolHostExecution) => options.onExecution?.(execution)

  const settle = (frame: ToolCallRequestFrame, startedAt: number, outcome: Outcome) => {
    const { executionId, toolName } = frame
    if (outcome.ok) {
      handle.sendToolCallResult(executionId, { type: 'json', value: outcome.value }, outcome.logs)
      track({ executionId, toolName, status: 'settled', startedAt, endedAt: Date.now() })
    } else {
      handle.sendToolCallError(executionId, outcome.reason, outcome.error, outcome.logs)
      track({ executionId, toolName, status: 'failed', reason: outcome.reason, startedAt, endedAt: Date.now() })
    }
  }

  const execute = async (frame: ToolCallRequestFrame, startedAt: number, work: Work): Promise<void> => {
    const controller = new AbortController()
    inFlight.set(frame.executionId, controller)
    track({ executionId: frame.executionId, toolName: frame.toolName, status: 'running', startedAt })
    let outcome: Outcome
    try {
      outcome = await work(controller.signal)
    } catch (error) {
      outcome = { ok: false, reason: 'host_error', error: errorMessage(error) }
    }
    try {
      if (!disposed && inFlight.has(frame.executionId)) {
        settle(frame, startedAt, outcome)
      }
    } finally {
      inFlight.delete(frame.executionId)
    }
  }

  const runClientTool = (frame: ToolCallRequestFrame, handler: ClientToolHandler, startedAt: number): Promise<void> =>
    execute(frame, startedAt, async (signal) => {
      const result = await handler(frame.input, { executionId: frame.executionId, signal })
      return 'error' in result
        ? { ok: false, reason: result.reason ?? 'client_error', error: result.error }
        : { ok: true, value: result.value }
    })

  const runScript = (frame: ToolCallRequestFrame, script: string, startedAt: number): Promise<void> =>
    execute(frame, startedAt, async (signal) => {
      const sandbox = await import('@workerdeck/sandbox')
      const vfs = sandbox.createVfs(frame.vfsSeed)
      // Never above what the server asked for: it owns the deadline it gives up at.
      const timeoutMs = Math.min(frame.limits?.timeoutMs ?? Number.POSITIVE_INFINITY, options.timeoutMs ?? 5000)
      const memoryLimitBytes = Math.min(
        frame.limits?.memoryLimitBytes ?? Number.POSITIVE_INFINITY,
        options.memoryLimitBytes ?? 64 * 1024 * 1024,
      )
      let result: RunScriptResult
      if (options.execute) {
        result = await options.execute({ script, vfs, timeoutMs, memoryLimitBytes, signal })
      } else {
        enginePromise ??= (options.loadEngine ?? defaultLoadEngine)()
        result = await sandbox.runScript(await enginePromise, {
          script,
          vfs,
          timeoutMs,
          memoryLimitBytes,
          signal,
          fetchText: options.fetchText,
        })
      }
      const logs = result.logs.map((l) => `[${l.level}] ${l.text}`)
      return result.ok ? { ok: true, value: result.value, logs } : { ok: false, reason: result.reason, error: result.error, logs }
    })

  const run = async (frame: ToolCallRequestFrame): Promise<void> => {
    const startedAt = Date.now()
    const clientHandler = options.clientTools?.[frame.toolName]
    if (clientHandler) {
      return runClientTool(frame, clientHandler, startedAt)
    }
    const allowed = options.tools ?? ['eval_script']
    if (!allowed.includes(frame.toolName)) {
      settle(frame, startedAt, { ok: false, reason: 'unsupported_tool', error: `this client does not execute '${frame.toolName}'` })
      return
    }
    const script = (frame.input as { script?: unknown } | undefined)?.script
    if (typeof script !== 'string') {
      settle(frame, startedAt, { ok: false, reason: 'invalid_input', error: 'expected a string `script` input' })
      return
    }
    return runScript(frame, script, startedAt)
  }

  const offRequest = handle.on('toolCallRequest', (frame) => void run(frame))
  const offCancel = handle.on('toolCallCanceled', ({ executionId, reason }) => {
    const controller = inFlight.get(executionId)
    if (!controller) {
      return
    }
    controller.abort()
    inFlight.delete(executionId)
    track({
      executionId,
      toolName: '',
      status: 'canceled',
      reason,
      startedAt: Date.now(),
      endedAt: Date.now(),
    })
  })

  return {
    dispose: () => {
      disposed = true
      offRequest()
      offCancel()
      for (const controller of inFlight.values()) {
        controller.abort()
      }
      inFlight.clear()
    },
  }
}

async function defaultLoadEngine(): Promise<SandboxEngine> {
  const [sandbox, variant] = await Promise.all([import('@workerdeck/sandbox'), import('@jitl/quickjs-singlefile-browser-release-asyncify')])
  return sandbox.loadEngine(variant as never)
}
