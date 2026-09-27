import { runScript, type SandboxEngine } from '@workerdeck/sandbox'
import { guardedFetch, hostMatches, urlDenyReason } from '../engines/provider/web-fetch.ts'
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
  // Applies to the default fetch only; a host `hostFetch` owns its own limits. Default 1 MiB.
  fetchMaxBytes?: number
  defaultTimeoutMs?: number
  defaultMemoryLimitBytes?: number
}

type EvalScriptInput = { script?: unknown }

const MAX_REDIRECTS = 5
const DEFAULT_FETCH_MAX_BYTES = 1024 * 1024

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
      if (this.#options.hostFetch) {
        return await this.#options.hostFetch(url, controller.signal)
      }
      return await defaultHostFetch(
        url,
        controller.signal,
        this.#options.allowedHosts ?? [],
        this.#options.fetchMaxBytes ?? DEFAULT_FETCH_MAX_BYTES,
      )
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

// Every hop is vetted against the allowlist and the private-address guard, and the connection itself is pinned by
// `guardedFetch`: following redirects blindly would let an allowlisted host bounce the guest anywhere.
async function defaultHostFetch(url: string, signal: AbortSignal, allowedHosts: string[], maxBytes: number): Promise<string> {
  let current = url
  for (let hop = 0; ; hop++) {
    const parsed = new URL(current)
    const denied = isHostAllowed(current, allowedHosts) ? await urlDenyReason(parsed, undefined) : `host not allowed: ${parsed.hostname}`
    if (denied) {
      throw new Error(denied)
    }
    const response = await guardedFetch(current, { signal })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`redirect (${response.status}) without a location`)
      }
      if (hop >= MAX_REDIRECTS) {
        throw new Error('too many redirects')
      }
      current = new URL(location, parsed).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`request failed: ${response.status}`)
    }
    return await readTextCapped(response, maxBytes)
  }
}

async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length') ?? '') > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`response too large (> ${maxBytes} bytes)`)
  }
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`response too large (> ${maxBytes} bytes)`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

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
  return hostMatches(parsed.hostname.toLowerCase(), allowedHosts)
}
