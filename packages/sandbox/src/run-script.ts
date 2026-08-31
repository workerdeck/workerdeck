import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from 'quickjs-emscripten-core'
import type { SandboxVfs } from './vfs.ts'

const PRELUDE = `
"use strict";
(() => {
  const fmt = (v) => {
    if (typeof v === 'string') return v
    if (v === undefined) return 'undefined'
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  globalThis.console = Object.freeze({
    log: (...a) => __host_log('log', a.map(fmt).join(' ')),
    warn: (...a) => __host_log('warn', a.map(fmt).join(' ')),
    error: (...a) => __host_log('error', a.map(fmt).join(' ')),
  })
  globalThis.vfs = Object.freeze({
    read: (p) => __host_vfs_read(String(p)),
    write: (p, c) => { __host_vfs_write(String(p), String(c)) },
    list: (d) => JSON.parse(__host_vfs_list(d === undefined ? '/' : String(d))),
  })
  globalThis.fetchText = (u) => __host_fetch_text(String(u))
})();
`

export type SandboxEngine = { module: QuickJSAsyncWASMModule }

export type SandboxVariantInput =
  | QuickJSAsyncVariant
  | { default: QuickJSAsyncVariant }
  | Promise<QuickJSAsyncVariant | { default: QuickJSAsyncVariant }>

export async function loadEngine(variant: SandboxVariantInput): Promise<SandboxEngine> {
  const resolved = await variant
  const unwrapped = 'default' in resolved ? resolved.default : resolved
  return { module: await newQuickJSAsyncWASMModuleFromVariant(unwrapped) }
}

export type SandboxLog = { level: 'log' | 'warn' | 'error'; text: string }

export type RunScriptOptions = {
  script: string
  vfs?: SandboxVfs
  fetchText?: (url: string) => Promise<string>
  memoryLimitBytes?: number
  timeoutMs?: number
  maxStackSizeBytes?: number
  signal?: AbortSignal
}

export type RunScriptResult =
  | { ok: true; value: unknown; logs: SandboxLog[] }
  | {
      ok: false
      reason: 'exception' | 'timeout' | 'oom' | 'aborted'
      error: string
      logs: SandboxLog[]
    }

export async function runScript(engine: SandboxEngine, options: RunScriptOptions): Promise<RunScriptResult> {
  const logs: SandboxLog[] = []
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  let interruptedBy: 'timeout' | 'aborted' | undefined

  const runtime = engine.module.newRuntime()
  runtime.setMemoryLimit(options.memoryLimitBytes ?? 64 * 1024 * 1024)
  runtime.setMaxStackSize(options.maxStackSizeBytes ?? 1024 * 1024)
  runtime.setInterruptHandler(() => {
    if (options.signal?.aborted) {
      interruptedBy = 'aborted'
      return true
    }
    if (Date.now() > deadline) {
      interruptedBy = 'timeout'
      return true
    }
    return false
  })
  const context = runtime.newContext()

  const defineHostFn = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
    const handle = context.newFunction(name, (...args) => fn(...args) ?? context.undefined)
    context.setProp(context.global, name, handle)
    handle.dispose()
  }

  try {
    defineHostFn('__host_log', (levelHandle, textHandle) => {
      const level = context.getString(levelHandle)
      logs.push({
        level: level === 'warn' || level === 'error' ? level : 'log',
        text: context.getString(textHandle),
      })
      return undefined
    })
    defineHostFn('__host_vfs_read', (pathHandle) => {
      const content = options.vfs?.read(context.getString(pathHandle))
      return content === undefined ? undefined : context.newString(content)
    })
    defineHostFn('__host_vfs_write', (pathHandle, contentHandle) => {
      if (!options.vfs) {
        throw new Error('vfs is not enabled for this execution')
      }
      options.vfs.write(context.getString(pathHandle), context.getString(contentHandle))
      return undefined
    })
    defineHostFn('__host_vfs_list', (dirHandle) => {
      const files = options.vfs?.list(context.getString(dirHandle)) ?? []
      return context.newString(JSON.stringify(files))
    })
    {
      const fetchText = options.fetchText
      const handle = context.newAsyncifiedFunction('__host_fetch_text', async (urlHandle) => {
        const url = context.getString(urlHandle)
        if (!fetchText) {
          throw new Error('network access is not enabled for this execution')
        }
        return context.newString(await fetchText(url))
      })
      context.setProp(context.global, '__host_fetch_text', handle)
      handle.dispose()
    }

    const prelude = await context.evalCodeAsync(PRELUDE, 'prelude.js')
    context.unwrapResult(prelude).dispose()

    const evaluated = await context.evalCodeAsync(options.script, 'script.js')
    if (evaluated.error) {
      const error = context.dump(evaluated.error)
      evaluated.error.dispose()
      return failure(error, interruptedBy, logs)
    }
    runtime.executePendingJobs()
    const evaluatedValue = evaluated.value
    const state = context.getPromiseState(evaluatedValue)
    if (state.type === 'pending') {
      const settledPromise = context.resolvePromise(evaluatedValue)
      runtime.executePendingJobs()
      const settled = await settledPromise
      evaluatedValue.dispose()
      if (settled.error) {
        const error = context.dump(settled.error)
        settled.error.dispose()
        return failure(error, interruptedBy, logs)
      }
      const value = context.dump(settled.value)
      settled.value.dispose()
      return { ok: true, value, logs }
    }
    if (state.type === 'rejected') {
      const error = context.dump(state.error)
      evaluatedValue.dispose()
      return failure(error, interruptedBy, logs)
    }
    const resultHandle = state.type === 'fulfilled' && !state.notAPromise ? state.value : evaluatedValue
    const value = context.dump(resultHandle)
    if (resultHandle !== evaluatedValue) {
      resultHandle.dispose()
    }
    evaluatedValue.dispose()
    return { ok: true, value, logs }
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), interruptedBy, logs)
  } finally {
    context.dispose()
    runtime.dispose()
  }
}

function failure(error: unknown, interruptedBy: 'timeout' | 'aborted' | undefined, logs: SandboxLog[]): RunScriptResult {
  const text = describeGuestError(error)
  const reason = interruptedBy ?? (/out of memory/i.test(text) ? 'oom' : 'exception')
  return { ok: false, reason, error: text, logs }
}

function describeGuestError(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown }
    const name = typeof e.name === 'string' ? e.name : undefined
    const message = typeof e.message === 'string' ? e.message : undefined
    if (name || message) {
      return [name, message].filter(Boolean).join(': ')
    }
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}
