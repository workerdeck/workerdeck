import type { SessionHandle } from '@workerdeck/client'
import type { RunScriptResult, SandboxEngine, SandboxVfs } from '@workerdeck/sandbox'
import type { ToolCallRequestFrame } from '@workerdeck/protocol'

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

export const createToolCallHost = (handle: SessionHandle, options: ToolCallHostOptions = {}): { dispose: () => void } => {
  const inFlight = new Map<string, AbortController>()
  let enginePromise: Promise<SandboxEngine> | undefined
  let disposed = false

  const track = (execution: ToolHostExecution) => options.onExecution?.(execution)

  const refuse = (frame: ToolCallRequestFrame, reason: string, error: string, startedAt: number) => {
    handle.sendToolCallError(frame.executionId, reason, error)
    track({
      executionId: frame.executionId,
      toolName: frame.toolName,
      status: 'failed',
      reason,
      startedAt,
      endedAt: Date.now(),
    })
  }

  const runClientTool = async (frame: ToolCallRequestFrame, handler: ClientToolHandler): Promise<void> => {
    const startedAt = Date.now()
    const controller = new AbortController()
    inFlight.set(frame.executionId, controller)
    track({ executionId: frame.executionId, toolName: frame.toolName, status: 'running', startedAt })

    try {
      const result = await handler(frame.input, {
        executionId: frame.executionId,
        signal: controller.signal,
      })
      if (disposed || !inFlight.has(frame.executionId)) {
        return
      }
      if ('error' in result) {
        handle.sendToolCallError(frame.executionId, result.reason ?? 'client_error', result.error)
        track({
          executionId: frame.executionId,
          toolName: frame.toolName,
          status: 'failed',
          reason: result.reason ?? 'client_error',
          startedAt,
          endedAt: Date.now(),
        })
      } else {
        handle.sendToolCallResult(frame.executionId, { type: 'json', value: result.value })
        track({
          executionId: frame.executionId,
          toolName: frame.toolName,
          status: 'settled',
          startedAt,
          endedAt: Date.now(),
        })
      }
    } catch (error) {
      if (disposed || !inFlight.has(frame.executionId)) {
        return
      }
      refuse(frame, 'host_error', error instanceof Error ? error.message : String(error), startedAt)
    } finally {
      inFlight.delete(frame.executionId)
    }
  }

  const run = async (frame: ToolCallRequestFrame): Promise<void> => {
    const startedAt = Date.now()
    const clientHandler = options.clientTools?.[frame.toolName]
    if (clientHandler) {
      return runClientTool(frame, clientHandler)
    }
    const allowed = options.tools ?? ['eval_script']
    if (!allowed.includes(frame.toolName)) {
      refuse(frame, 'unsupported_tool', `this client does not execute '${frame.toolName}'`, startedAt)
      return
    }
    const script = (frame.input as { script?: unknown } | undefined)?.script
    if (typeof script !== 'string') {
      refuse(frame, 'invalid_input', 'expected a string `script` input', startedAt)
      return
    }

    const controller = new AbortController()
    inFlight.set(frame.executionId, controller)
    track({ executionId: frame.executionId, toolName: frame.toolName, status: 'running', startedAt })

    try {
      const sandbox = await import('@workerdeck/sandbox')
      const vfs = sandbox.createVfs(frame.vfsSeed)
      // Never above what the server asked for: it owns the deadline it gives up at.
      const timeoutMs = Math.min(frame.limits?.timeoutMs ?? Number.POSITIVE_INFINITY, options.timeoutMs ?? 5000)
      const memoryLimitBytes = Math.min(
        frame.limits?.memoryLimitBytes ?? Number.POSITIVE_INFINITY,
        options.memoryLimitBytes ?? 64 * 1024 * 1024,
      )

      const result = options.execute
        ? await options.execute({ script, vfs, timeoutMs, memoryLimitBytes, signal: controller.signal })
        : await (async () => {
            enginePromise ??= (options.loadEngine ?? defaultLoadEngine)()
            return sandbox.runScript(await enginePromise, {
              script,
              vfs,
              timeoutMs,
              memoryLimitBytes,
              signal: controller.signal,
              fetchText: options.fetchText,
            })
          })()

      if (disposed || !inFlight.has(frame.executionId)) {
        return
      }
      const logs = result.logs.map((l) => `[${l.level}] ${l.text}`)
      if (result.ok) {
        handle.sendToolCallResult(frame.executionId, { type: 'json', value: result.value }, logs)
        track({
          executionId: frame.executionId,
          toolName: frame.toolName,
          status: 'settled',
          startedAt,
          endedAt: Date.now(),
        })
      } else {
        handle.sendToolCallError(frame.executionId, result.reason, result.error, logs)
        track({
          executionId: frame.executionId,
          toolName: frame.toolName,
          status: 'failed',
          reason: result.reason,
          startedAt,
          endedAt: Date.now(),
        })
      }
    } catch (error) {
      if (disposed || !inFlight.has(frame.executionId)) {
        return
      }
      refuse(frame, 'host_error', error instanceof Error ? error.message : String(error), startedAt)
    } finally {
      inFlight.delete(frame.executionId)
    }
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

const defaultLoadEngine = async (): Promise<SandboxEngine> => {
  const [sandbox, variant] = await Promise.all([import('@workerdeck/sandbox'), import('@jitl/quickjs-singlefile-browser-release-asyncify')])
  return sandbox.loadEngine(variant as never)
}
