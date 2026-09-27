import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import { QuickJsExecutor, type ToolExecutionCall } from '../src/index.ts'

const guardedFetch = vi.hoisted(() => vi.fn<(url: string) => Promise<Response>>())

vi.mock('../src/engines/provider/web-fetch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engines/provider/web-fetch.ts')>()),
  guardedFetch,
}))

let engine: SandboxEngine
beforeAll(async () => {
  engine = await loadEngine(variant)
})

beforeEach(() => {
  guardedFetch.mockReset()
})

// TEST-NET literals keep the private-address pre-check off real DNS.
const ALLOWED = ['203.0.113.5', '127.0.0.1']

async function fetchInGuest(url: string, options: { fetchMaxBytes?: number } = {}): Promise<string> {
  const executor = new QuickJsExecutor({ engine, allowedHosts: ALLOWED, ...options })
  const script = `try { fetchText(${JSON.stringify(url)}) } catch (e) { "caught: " + e.message }`
  const dispatch = await executor.dispatch({
    executionId: 'e',
    sessionId: 's',
    tool: 'eval_script',
    input: { script },
  } satisfies ToolExecutionCall)
  return (dispatch as { result: { output: string } }).result.output
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

describe('QuickJsExecutor default fetch', () => {
  it('follows a redirect only while every hop stays on the allowlist', async () => {
    guardedFetch.mockResolvedValueOnce(redirect('http://198.51.100.7/elsewhere'))
    expect(await fetchInGuest('http://203.0.113.5/start')).toBe('caught: host not allowed: 198.51.100.7')
    expect(guardedFetch).toHaveBeenCalledOnce()
  })

  it('refuses a redirect onto a private address even when the allowlist names it', async () => {
    guardedFetch.mockResolvedValueOnce(redirect('http://127.0.0.1/admin'))
    expect(await fetchInGuest('http://203.0.113.5/start')).toBe('caught: address not allowed: 127.0.0.1')
    expect(guardedFetch).toHaveBeenCalledOnce()
  })

  it('follows an allowed same-list redirect', async () => {
    guardedFetch.mockResolvedValueOnce(redirect('/final')).mockResolvedValueOnce(new Response('landed'))
    expect(await fetchInGuest('http://203.0.113.5/start')).toBe('landed')
    expect(guardedFetch.mock.calls.map(([url]) => url)).toEqual(['http://203.0.113.5/start', 'http://203.0.113.5/final'])
  })

  it('caps the body', async () => {
    guardedFetch.mockResolvedValueOnce(new Response('x'.repeat(4096)))
    expect(await fetchInGuest('http://203.0.113.5/big', { fetchMaxBytes: 1024 })).toBe('caught: response too large (> 1024 bytes)')
  })
})
