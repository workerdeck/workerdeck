import { runScript, type SandboxEngine } from '@workerdeck/sandbox'
import type { ToolExecutionCall, ToolExecutionDispatch, ToolExecutionResult, ToolExecutor } from './tool-executor.ts'

/** Resolve a URL to text for the guest. Runs host-side with host authority —
 * this is where a credential may be attached, never inside the sandbox. */
export type HostFetch = (url: string, signal: AbortSignal) => Promise<string>

export type QuickJsExecutorOptions = {
  engine: SandboxEngine
  /**
   * Hostnames the guest may reach, exact or `*.example.com`. Empty/unset =
   * no network at all (the guest's fetchText throws). Matched host-side; the
   * guest is never told the allowlist and never holds a credential.
   */
  allowedHosts?: string[]
  /** Performs the actual request. Unset = global fetch, text body. */
  hostFetch?: HostFetch
  /** Per-fetch cap. The guest deadline does NOT cover host-function time, so
   * every capability needs its own bound. Default 10000. */
  fetchTimeoutMs?: number
  /** Default guest wall-clock limit when the call doesn't set one. Default 5000. */
  defaultTimeoutMs?: number
  /** Default guest allocator cap when the call doesn't set one. Default 64 MiB. */
  defaultMemoryLimitBytes?: number
}

/** Tool input for `eval_script`. */
type EvalScriptInput = { script?: unknown }

/**
 * In-process execution backend: runs a tool's untrusted script in the QuickJS
 * WASM guest. Always settles inline — nothing downstream assumes that, which is
 * what lets a deferred backend replace it behind the same seam.
 */
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
    // The guest's interrupt deadline cannot preempt a host call — bound it here.
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

async function defaultHostFetch(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`)
  }
  return await response.text()
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** Exact hostname match, or a single leading `*.` wildcard covering subdomains
 * (not the bare parent). Only http(s) — no file:, data:, or other schemes. */
export function isHostAllowed(url: string, allowedHosts: string[]): boolean {
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
