import { runScript, type SandboxEngine } from '@workerdeck/sandbox'
import type { ToolExecutionCall, ToolExecutionDispatch, ToolExecutionResult, ToolExecutor } from './tool-executor.ts'

export type HostFetch = (url: string, signal: AbortSignal) => Promise<string>

export type QuickJsExecutorOptions = {
  engine: SandboxEngine
  // Matched host-side: the guest is never told the allowlist and never holds a credential.
  allowedHosts?: string[]
  hostFetch?: HostFetch
  // The guest's interrupt deadline does not cover host-function time, so every granted
  // capability needs its own bound. Default 10000.
  fetchTimeoutMs?: number
  defaultTimeoutMs?: number
  defaultMemoryLimitBytes?: number
}

type EvalScriptInput = { script?: unknown }

export class QuickJsExecutor implements ToolExecutor {
  #options: QuickJsExecutorOptions

  constructor(options: QuickJsExecutorOptions) {
    this.#options = options
  }

  async dispatch(call: ToolExecutionCall): Promise<ToolExecutionDispatch> {
    return {
      executionId: call.executionId,
      status: 'settled',
      result: await this.#execute(call),
    }
  }

  async #execute(call: ToolExecutionCall): Promise<ToolExecutionResult> {
    if (call.tool !== 'eval_script') {
      return {
        status: 'failed',
        reason: 'unsupported_tool',
        error: `tool '${call.tool}' is not executable by the QuickJS backend`,
      }
    }
    const script = (call.input as EvalScriptInput | undefined)?.script
    if (typeof script !== 'string') {
      return {
        status: 'failed',
        reason: 'invalid_input',
        error: 'eval_script requires a string `script` input',
      }
    }
    const result = await runScript(this.#options.engine, {
      script,
      vfs: call.vfs,
      signal: call.signal,
      timeoutMs: call.limits?.timeoutMs ?? this.#options.defaultTimeoutMs ?? 5000,
      memoryLimitBytes: call.limits?.memoryLimitBytes ?? this.#options.defaultMemoryLimitBytes ?? 64 * 1024 * 1024,
      fetchText: this.#allowsNetwork() ? (url) => this.#fetchText(url, call.signal) : undefined,
    })
    const logs = result.logs.map((l) => `[${l.level}] ${l.text}`)
    return result.ok ? { status: 'ok', output: result.value, logs } : { status: 'failed', reason: result.reason, error: result.error, logs }
  }

  #allowsNetwork(): boolean {
    return (this.#options.allowedHosts?.length ?? 0) > 0
  }

  async #fetchText(url: string, outer: AbortSignal | undefined): Promise<string> {
    if (!isHostAllowed(url, this.#options.allowedHosts ?? [])) {
      throw new Error(`host not allowed: ${safeHost(url) ?? url}`)
    }
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    outer?.addEventListener('abort', onOuterAbort)
    const timer = setTimeout(() => controller.abort(), this.#options.fetchTimeoutMs ?? 10_000)
    try {
      const fetchImpl = this.#options.hostFetch ?? defaultHostFetch
      return await fetchImpl(url, controller.signal)
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

const defaultHostFetch = async (url: string, signal: AbortSignal): Promise<string> => {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`)
  }
  return await response.text()
}

const safeHost = (url: string): string | undefined => {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

export const isHostAllowed = (url: string, allowedHosts: string[]): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return allowedHosts.some((entry) => {
    const pattern = entry.trim().toLowerCase()
    if (!pattern) {
      return false
    }
    if (pattern.startsWith('*.')) {
      return host.endsWith(pattern.slice(1))
    }
    return host === pattern
  })
}
