import { describe, expect, it, vi } from 'vitest'
import type { ToolCallRequestFrame } from '@workerdeck/protocol'
import { createVfs } from '@workerdeck/sandbox'
import { BrowserBridgeExecutor, type ToolExecutionCall, type ToolExecutionResult } from '../src/index.ts'

function harness(options: { send?: () => boolean; timeoutMs?: number } = {}) {
  const sent: ToolCallRequestFrame[] = []
  const canceled: Array<{ executionId: string; reason: string }> = []
  const results: Array<{ executionId: string; result: ToolExecutionResult }> = []
  const executor = new BrowserBridgeExecutor({
    send: (frame) => {
      sent.push(frame)
      return options.send ? options.send() : true
    },
    cancel: (executionId, reason) => canceled.push({ executionId, reason }),
    onResult: (executionId, result) => results.push({ executionId, result }),
    timeoutMs: options.timeoutMs,
  })
  return { executor, sent, canceled, results }
}

const call = (overrides: Partial<ToolExecutionCall> = {}): ToolExecutionCall => ({
  executionId: 'exec-1',
  sessionId: 'sess-1',
  tool: 'eval_script',
  input: { script: '1+1' },
  ...overrides,
})

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0))
}

describe('BrowserBridgeExecutor', () => {
  it('returns pending and puts a tool_call_request on the wire', async () => {
    const h = harness()
    const dispatch = await h.executor.dispatch(call())
    expect(dispatch).toEqual({ executionId: 'exec-1', status: 'pending' })
    expect(h.sent[0]).toMatchObject({
      type: 'tool_call_request',
      executionId: 'exec-1',
      toolName: 'eval_script',
      input: { script: '1+1' },
    })
    expect(h.sent[0]!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('seeds the client VFS so documents can stay on the client', async () => {
    const h = harness()
    await h.executor.dispatch(call({ vfs: createVfs({ '/doc.txt': 'body' }) }))
    expect(h.sent[0]!.vfsSeed).toEqual({ '/doc.txt': 'body' })
  })

  it('delivers a client answer as the execution result', async () => {
    const h = harness()
    await h.executor.dispatch(call())
    expect(h.executor.resolve('exec-1', { output: { type: 'json', value: { n: 2 } }, logs: ['[log] hi'] })).toBe(true)
    await settle()
    expect(h.results).toEqual([{ executionId: 'exec-1', result: { status: 'ok', output: { n: 2 }, logs: ['[log] hi'] } }])
  })

  it('delivers a client-side failure as a failed result, not an exception', async () => {
    const h = harness()
    await h.executor.dispatch(call())
    h.executor.resolve('exec-1', { reason: 'guest_error', error: 'boom' })
    await settle()
    expect(h.results[0]!.result).toMatchObject({ status: 'failed', reason: 'guest_error', error: 'boom' })
    // The client told us; no need to tell it to stop.
    expect(h.canceled).toEqual([])
  })

  it('fails immediately when no client is attached instead of waiting out the deadline', async () => {
    const h = harness({ send: () => false })
    const dispatch = await h.executor.dispatch(call())
    expect(dispatch).toMatchObject({
      status: 'settled',
      result: { status: 'failed', reason: 'no_client' },
    })
  })

  it('times out a silent client and tells it to abandon the call', async () => {
    const h = harness({ timeoutMs: 20 })
    await h.executor.dispatch(call())
    await vi.waitFor(() => expect(h.results).toHaveLength(1))
    expect(h.results[0]!.result).toMatchObject({ status: 'failed', reason: 'timeout' })
    expect(h.canceled).toEqual([{ executionId: 'exec-1', reason: 'timeout' }])
  })

  it('ignores a late answer that arrives after the timeout', async () => {
    const h = harness({ timeoutMs: 20 })
    await h.executor.dispatch(call())
    await vi.waitFor(() => expect(h.results).toHaveLength(1))
    expect(h.executor.resolve('exec-1', { output: { type: 'text', value: 'too late' } })).toBe(false)
    await settle()
    // Still exactly one terminal result — the settled call did not re-open.
    expect(h.results).toHaveLength(1)
    expect(h.results[0]!.result).toMatchObject({ reason: 'timeout' })
  })

  it('ignores a duplicate answer', async () => {
    const h = harness()
    await h.executor.dispatch(call())
    expect(h.executor.resolve('exec-1', { output: { type: 'text', value: 'first' } })).toBe(true)
    expect(h.executor.resolve('exec-1', { output: { type: 'text', value: 'second' } })).toBe(false)
    await settle()
    expect(h.results).toHaveLength(1)
    expect(h.results[0]!.result).toMatchObject({ output: 'first' })
  })

  it('fails in-flight calls when the turn is aborted', async () => {
    const h = harness()
    const controller = new AbortController()
    await h.executor.dispatch(call({ signal: controller.signal }))
    controller.abort()
    await settle()
    expect(h.results[0]!.result).toMatchObject({ status: 'failed', reason: 'aborted' })
    expect(h.canceled).toEqual([{ executionId: 'exec-1', reason: 'aborted' }])
  })

  it('shares one registry across kinds so approvals and bridged calls live together', async () => {
    const h = harness()
    void h.executor.registry.register({ id: 'approval-1', kind: 'approval' })
    await h.executor.dispatch(call())
    expect(
      h.executor.registry
        .list()
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['approval', 'tool_call'])
    expect(h.executor.registry.get('exec-1')).toMatchObject({ meta: { toolName: 'eval_script' } })
  })
})
