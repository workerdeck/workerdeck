import { beforeAll, describe, expect, it, vi } from 'vitest'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import { QuickJsExecutor, isHostAllowed, type ToolExecutionCall } from '../src/index.ts'

let engine: SandboxEngine
beforeAll(async () => {
  engine = await loadEngine(variant)
})

const call = (overrides: Partial<ToolExecutionCall> = {}): ToolExecutionCall => ({
  executionId: 'exec-1',
  sessionId: 'sess-1',
  tool: 'eval_script',
  input: { script: '1 + 1' },
  ...overrides,
})

describe('QuickJsExecutor', () => {
  it('settles inline, echoing the executionId back for correlation', async () => {
    const executor = new QuickJsExecutor({ engine })
    const dispatch = await executor.dispatch(call({ executionId: 'exec-42' }))
    expect(dispatch).toMatchObject({
      executionId: 'exec-42',
      status: 'settled',
      result: { status: 'ok', output: 2 },
    })
  })

  it('runs against the call-scoped VFS and surfaces guest logs', async () => {
    const vfs = createVfs({ '/in.txt': 'hello' })
    const executor = new QuickJsExecutor({ engine })
    const dispatch = await executor.dispatch(
      call({
        input: {
          script: `console.log('working'); vfs.write('/out.txt', vfs.read('/in.txt').toUpperCase()); 'done'`,
        },
        vfs,
      }),
    )
    expect(dispatch).toMatchObject({ result: { status: 'ok', output: 'done', logs: ['[log] working'] } })
    expect(vfs.read('/out.txt')).toBe('HELLO')
  })

  it('reports guest failures as structured results, never throwing', async () => {
    const executor = new QuickJsExecutor({ engine })
    const timedOut = await executor.dispatch(
      call({ input: { script: 'while (true) {}' }, limits: { timeoutMs: 150 } }),
    )
    expect(timedOut).toMatchObject({ status: 'settled', result: { status: 'failed', reason: 'timeout' } })

    const threw = await executor.dispatch(call({ input: { script: 'null.x' } }))
    expect(threw).toMatchObject({ result: { status: 'failed', reason: 'exception' } })
  })

  it('rejects unknown tools and malformed input without running anything', async () => {
    const executor = new QuickJsExecutor({ engine })
    await expect(executor.dispatch(call({ tool: 'web_search' }))).resolves.toMatchObject({
      result: { status: 'failed', reason: 'unsupported_tool' },
    })
    await expect(executor.dispatch(call({ input: { script: 42 } }))).resolves.toMatchObject({
      result: { status: 'failed', reason: 'invalid_input' },
    })
  })

  it('denies network by default; an allowlisted host reaches the host fetch', async () => {
    const denied = new QuickJsExecutor({ engine })
    const deniedResult = await denied.dispatch(
      call({ input: { script: 'try { fetchText("https://ok.example/x") } catch (e) { e.message }' } }),
    )
    expect((deniedResult as { result: { output: string } }).result.output).toContain('not enabled')

    const hostFetch = vi.fn(async () => 'document body')
    const allowed = new QuickJsExecutor({ engine, allowedHosts: ['ok.example'], hostFetch })
    const allowedResult = await allowed.dispatch(
      call({ input: { script: 'fetchText("https://ok.example/x")' } }),
    )
    expect(allowedResult).toMatchObject({ result: { status: 'ok', output: 'document body' } })
    expect(hostFetch).toHaveBeenCalledOnce()
  })

  it('blocks non-allowlisted hosts host-side — the guest never learns the policy', async () => {
    const hostFetch = vi.fn(async () => 'secret')
    const executor = new QuickJsExecutor({ engine, allowedHosts: ['ok.example'], hostFetch })
    const result = await executor.dispatch(
      call({ input: { script: 'try { fetchText("https://evil.example/x") } catch (e) { e.message }' } }),
    )
    expect((result as { result: { output: string } }).result.output).toContain('host not allowed')
    expect(hostFetch).not.toHaveBeenCalled()
  })

  it('bounds a hanging host fetch independently of the guest deadline', async () => {
    const hostFetch = vi.fn(
      (_url: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by host timeout')))
        }),
    )
    const executor = new QuickJsExecutor({
      engine,
      allowedHosts: ['ok.example'],
      hostFetch,
      fetchTimeoutMs: 100,
    })
    const result = await executor.dispatch(
      call({
        input: { script: 'try { fetchText("https://ok.example/slow") } catch (e) { "caught: " + e.message }' },
        // Guest deadline is generous: the host-side bound is what must fire.
        limits: { timeoutMs: 10_000 },
      }),
    )
    expect((result as { result: { output: string } }).result.output).toContain('caught:')
    // Outer timeout > the 10s guest deadline above: if the host bound ever stops
    // firing, this must fail on the assertion, not as an ambiguous vitest timeout.
  }, 20_000)
})

describe('isHostAllowed', () => {
  it('matches exact hosts and single-level wildcards, case-insensitively', () => {
    expect(isHostAllowed('https://ok.example/p', ['ok.example'])).toBe(true)
    expect(isHostAllowed('https://OK.example/p', ['ok.example'])).toBe(true)
    expect(isHostAllowed('https://a.ok.example/p', ['*.ok.example'])).toBe(true)
    expect(isHostAllowed('https://deep.a.ok.example/p', ['*.ok.example'])).toBe(true)
    // The bare parent is not covered by a wildcard entry.
    expect(isHostAllowed('https://ok.example/p', ['*.ok.example'])).toBe(false)
  })

  it('rejects near-miss hosts, non-http schemes, and junk', () => {
    expect(isHostAllowed('https://ok.example.evil.com/p', ['ok.example'])).toBe(false)
    expect(isHostAllowed('https://notok.example/p', ['ok.example'])).toBe(false)
    expect(isHostAllowed('file:///etc/passwd', ['ok.example'])).toBe(false)
    expect(isHostAllowed('data:text/plain,hi', ['ok.example'])).toBe(false)
    expect(isHostAllowed('not a url', ['ok.example'])).toBe(false)
    expect(isHostAllowed('https://ok.example/p', [])).toBe(false)
    expect(isHostAllowed('https://ok.example/p', ['', '  '])).toBe(false)
  })
})
