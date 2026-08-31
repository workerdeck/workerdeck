import { describe, expect, it, vi } from 'vitest'
import type { SessionHandle } from '@workerdeck/client'
import type { ToolCallRequestFrame } from '@workerdeck/protocol'
import type { RunScriptResult } from '@workerdeck/sandbox'
import { createToolCallHost, type ToolCallHostOptions } from '../src/lib/tool-host.ts'

function fakeHandle() {
  const listeners = {
    toolCallRequest: [] as Array<(f: ToolCallRequestFrame) => void>,
    toolCallCanceled: [] as Array<(p: { executionId: string; reason: string }) => void>,
  }
  const results: Array<{ executionId: string; output: unknown; logs?: string[] }> = []
  const errors: Array<{ executionId: string; reason: string; error: string; logs?: string[] }> = []
  const handle = {
    on: (kind: 'toolCallRequest' | 'toolCallCanceled', listener: never) => {
      listeners[kind].push(listener)
      return () => {
        const list = listeners[kind] as unknown[]
        const i = list.indexOf(listener)
        if (i >= 0) {
          list.splice(i, 1)
        }
      }
    },
    sendToolCallResult: (executionId: string, output: { type: string; value: unknown }, logs?: string[]) => {
      results.push({ executionId, output: output.value, logs })
    },
    sendToolCallError: (executionId: string, reason: string, error: string, logs?: string[]) => {
      errors.push({ executionId, reason, error, logs })
    },
  } as unknown as SessionHandle
  const request = (frame: Partial<ToolCallRequestFrame> = {}) => {
    const full: ToolCallRequestFrame = {
      type: 'tool_call_request',
      executionId: 'exec-1',
      toolName: 'eval_script',
      input: { script: '1+1' },
      ...frame,
    }
    for (const listener of listeners.toolCallRequest) {
      listener(full)
    }
  }
  const cancel = (executionId: string, reason = 'timeout') => {
    for (const listener of listeners.toolCallCanceled) {
      listener({ executionId, reason })
    }
  }
  return { handle, results, errors, request, cancel }
}

function mount(handle: SessionHandle, options: ToolCallHostOptions) {
  const host = createToolCallHost(handle, options)
  return { cleanup: () => host.dispose() }
}

function ok(value: unknown): RunScriptResult {
  return { ok: true, value, logs: [{ level: 'log', text: 'hi' }] }
}

describe('tool-call host', () => {
  it('executes an allowed tool and returns the value with logs', async () => {
    const h = fakeHandle()
    const execute = vi.fn(async () => ok(2))
    const { cleanup } = mount(h.handle, { execute })
    h.request()
    await vi.waitFor(() => expect(h.results).toHaveLength(1))
    expect(h.results[0]).toMatchObject({ executionId: 'exec-1', output: 2, logs: ['[log] hi'] })
    cleanup?.()
  })

  it('refuses a tool it was not configured to run', async () => {
    const h = fakeHandle()
    const execute = vi.fn(async () => ok(1))
    const { cleanup } = mount(h.handle, { execute })
    h.request({ toolName: 'Bash', input: { command: 'rm -rf /' } })
    await vi.waitFor(() => expect(h.errors).toHaveLength(1))
    expect(h.errors[0]).toMatchObject({ reason: 'unsupported_tool' })
    expect(execute).not.toHaveBeenCalled()
    cleanup?.()
  })

  it('rejects malformed input without executing', async () => {
    const h = fakeHandle()
    const execute = vi.fn(async () => ok(1))
    const { cleanup } = mount(h.handle, { execute })
    h.request({ input: { script: 42 } })
    await vi.waitFor(() => expect(h.errors).toHaveLength(1))
    expect(h.errors[0]).toMatchObject({ reason: 'invalid_input' })
    expect(execute).not.toHaveBeenCalled()
    cleanup?.()
  })

  it('reports a guest failure so the agent can adapt', async () => {
    const h = fakeHandle()
    const execute = vi.fn(async (): Promise<RunScriptResult> => ({ ok: false, reason: 'timeout', error: 'deadline', logs: [] }))
    const { cleanup } = mount(h.handle, { execute })
    h.request()
    await vi.waitFor(() => expect(h.errors).toHaveLength(1))
    expect(h.errors[0]).toMatchObject({ reason: 'timeout', error: 'deadline' })
    cleanup?.()
  })

  it('reports engine/host failures instead of leaving the server waiting', async () => {
    const h = fakeHandle()
    const execute = vi.fn(async () => {
      throw new Error('failed to load wasm')
    })
    const { cleanup } = mount(h.handle, { execute })
    h.request()
    await vi.waitFor(() => expect(h.errors).toHaveLength(1))
    expect(h.errors[0]).toMatchObject({ reason: 'host_error', error: 'failed to load wasm' })
    cleanup?.()
  })

  it('never exceeds the deadline the server asked for', async () => {
    const h = fakeHandle()
    const seen: number[] = []
    const execute = vi.fn(async (req: { timeoutMs: number }) => {
      seen.push(req.timeoutMs)
      return ok(1)
    })
    const { cleanup } = mount(h.handle, { execute, timeoutMs: 30_000 })
    h.request({ limits: { timeoutMs: 500 } })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toBe(500)
    cleanup?.()
  })

  it('aborts an in-flight execution when the server cancels it', async () => {
    const h = fakeHandle()
    let captured: AbortSignal | undefined
    const execute = vi.fn(
      (req: { signal: AbortSignal }) =>
        new Promise<RunScriptResult>((resolve) => {
          captured = req.signal
          req.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted', error: 'canceled', logs: [] }))
        }),
    )
    const { cleanup } = mount(h.handle, { execute })
    h.request()
    await vi.waitFor(() => expect(captured).toBeDefined())
    h.cancel('exec-1')
    expect(captured!.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.results).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
    cleanup?.()
  })

  it('stops answering once unmounted', async () => {
    const h = fakeHandle()
    const execute = vi.fn(async () => ok(1))
    const { cleanup } = mount(h.handle, { execute })
    cleanup?.()
    h.request()
    await new Promise((r) => setTimeout(r, 20))
    expect(execute).not.toHaveBeenCalled()
    expect(h.results).toHaveLength(0)
  })

  it('seeds the guest VFS from the request', async () => {
    const h = fakeHandle()
    let read: string | undefined
    const execute = vi.fn(async (req: { vfs: { read: (p: string) => string | undefined } }) => {
      read = req.vfs.read('/doc.txt')
      return ok(1)
    })
    const { cleanup } = mount(h.handle, { execute })
    h.request({ vfsSeed: { '/doc.txt': 'body' } })
    await vi.waitFor(() => expect(h.results).toHaveLength(1))
    expect(read).toBe('body')
    cleanup?.()
  })
})
