import type { SessionHandle } from '@workerdeck/client'
import type { RunScriptResult, SandboxEngine, SandboxVfs } from '@workerdeck/sandbox'
import type { ToolCallRequestFrame } from '@workerdeck/protocol'

/** What the host was asked to do and how it went (for UI/telemetry). */
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

/**
 * Result a client tool handler returns. Return a plain value and it is sent as
 * JSON; return an object with `error` to fail the call with a reason the agent
 * can adapt to.
 */
export type ClientToolResult =
  | { value: unknown }
  | { error: string; reason?: string }

/**
 * Handler for a client-registered tool. Receives the model's validated input
 * and returns a result — or throws, which is treated as a host error.
 */
export type ClientToolHandler = (
  input: unknown,
  context: { executionId: string; signal: AbortSignal },
) => ClientToolResult | Promise<ClientToolResult>

export type ToolCallHostOptions = {
  /** Tools this client will execute. Anything else is refused, so a server can
   * never talk this tab into running something it didn't opt into.
   * Default: `['eval_script']`. */
  tools?: string[]
  /**
   * Client-side tool handlers, keyed by tool name. When a `tool_call_request`
   * arrives for a name in this map, the handler is called instead of the
   * sandbox. The tool must also appear in {@link tools} (it is added
   * automatically when `clientTools` is set).
   *
   * This is the client half of the round trip — the server half is registering
   * the tool's schema (via `tools` on `ProviderRunnerOptions` or
   * `EngineSessionOptions`). Together they let an embedder define a tool the
   * model can call and the client handles:
   *
   * ```ts
   * // Server: register the schema
   * tools: { app_navigate: { trust: 'sandboxed', tool: tool({ ... }) } }
   * // Client: handle the call
   * <SessionPanel clientTools={{ app_navigate: (input) => ({ value: 'ok' }) }} />
   * ```
   */
  clientTools?: Record<string, ClientToolHandler>
  /** Guest wall-clock limit, unless the request asks for less. Default 5000. */
  timeoutMs?: number
  /** Guest allocator cap, unless the request asks for less. Default 64 MiB. */
  memoryLimitBytes?: number
  /**
   * Load the WASM guest engine. Called at most once, on the first bridged call
   * — nothing is downloaded or parsed until a session actually bridges one.
   * Defaults to `@workerdeck/sandbox` with the single-file browser build.
   */
  loadEngine?: () => Promise<SandboxEngine>
  /**
   * Run the script. Defaults to executing on this thread, which is fine for the
   * short, time-boxed evaluations this is built for. Supply your own (a Web
   * Worker running the same engine) to keep long evaluations off the UI thread
   * — the guest deadline preempts the interpreter, but only between bytecode
   * ops on whichever thread it runs on.
   */
  execute?: ToolHostRunner
  /** Host-gated fetch for the guest. Omitted = the guest has no network at all. */
  fetchText?: (url: string) => Promise<string>
  /** Observe executions (rendering, logging). */
  onExecution?: (execution: ToolHostExecution) => void
}

/**
 * Answers server-bridged tool calls by executing them in this browser tab.
 * Framework-free — {@link useToolCallHost} is a thin React wrapper.
 *
 * The point is data locality: documents fetched or held client-side can be
 * evaluated here and never touch the server. The engine loads lazily, so a page
 * that never bridges a call never pays for the WASM guest.
 */
export function createToolCallHost(
  handle: SessionHandle,
  options: ToolCallHostOptions = {},
): { dispose: () => void } {
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

  const runClientTool = async (
    frame: ToolCallRequestFrame,
    handler: ClientToolHandler,
  ): Promise<void> => {
    const startedAt = Date.now()
    const controller = new AbortController()
    inFlight.set(frame.executionId, controller)
    track({ executionId: frame.executionId, toolName: frame.toolName, status: 'running', startedAt })

    try {
      const result = await handler(frame.input, {
        executionId: frame.executionId,
        signal: controller.signal,
      })
      if (disposed || !inFlight.has(frame.executionId)) return
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
      if (disposed || !inFlight.has(frame.executionId)) return
      refuse(frame, 'host_error', error instanceof Error ? error.message : String(error), startedAt)
    } finally {
      inFlight.delete(frame.executionId)
    }
  }

  const run = async (frame: ToolCallRequestFrame): Promise<void> => {
    const startedAt = Date.now()
    // Client tool handlers take priority: they are purpose-built for the tool.
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
      // Never exceed what the server asked for: it owns the deadline it will
      // give up at, and answering after that is wasted work.
      const timeoutMs = Math.min(
        frame.limits?.timeoutMs ?? Number.POSITIVE_INFINITY,
        options.timeoutMs ?? 5000,
      )
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

      // Cancelled or torn down while we worked: the server is no longer waiting.
      if (disposed || !inFlight.has(frame.executionId)) return
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
      if (disposed || !inFlight.has(frame.executionId)) return
      // Engine load failures land here �� tell the server so the agent can adapt
      // instead of waiting out the deadline.
      refuse(frame, 'host_error', error instanceof Error ? error.message : String(error), startedAt)
    } finally {
      inFlight.delete(frame.executionId)
    }
  }

  const offRequest = handle.on('toolCallRequest', (frame) => void run(frame))
  const offCancel = handle.on('toolCallCanceled', ({ executionId, reason }) => {
    const controller = inFlight.get(executionId)
    if (!controller) return
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
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
    },
  }
}

/** The single-file browser build keeps this to one lazy chunk — no separate
 * .wasm fetch, and nothing at all until the first bridged call. */
async function defaultLoadEngine(): Promise<SandboxEngine> {
  const [sandbox, variant] = await Promise.all([
    import('@workerdeck/sandbox'),
    import('@jitl/quickjs-singlefile-browser-release-asyncify'),
  ])
  return sandbox.loadEngine(variant as never)
}
