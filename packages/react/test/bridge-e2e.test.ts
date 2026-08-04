import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import { createVfs, loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import type { ToolExecutionResult } from '@workerdeck/core'
import { WorkerDeckClient, type SessionHandle } from '@workerdeck/client'
import { createToolCallHost } from '../src/tool-host.ts'

/**
 * The whole M3 path with nothing faked but the model: a server dispatches a
 * tool call over the wire, the client host executes it in a real QuickJS guest
 * against a VFS seeded from the request, and the result travels back to the
 * server's executor.
 */
function idleQueryFn() {
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => new Promise<never>(() => {}),
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  }
  return (() => query) as never
}

let engine: SandboxEngine | undefined
const getEngine = async () => (engine ??= await loadEngine(variant))

let running: WorkerServer | undefined
let handle: SessionHandle | undefined
let host: { dispose: () => void } | undefined
const results: Array<{ executionId: string; result: ToolExecutionResult }> = []

afterEach(async () => {
  host?.dispose()
  host = undefined
  handle?.detach()
  handle = undefined
  await running?.close()
  running = undefined
  results.length = 0
})

async function start(bridgeTimeoutMs?: number) {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: idleQueryFn() }),
    bridge: {
      timeoutMs: bridgeTimeoutMs,
      onResult: (_s, executionId, result) => results.push({ executionId, result }),
    },
  })
  const { port } = await running.listen(0, '127.0.0.1')
  const client = new WorkerDeckClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  const session = await client.createSession({ cwd: '/tmp/project' })
  handle = client.attach(session.id)
  await new Promise<void>((resolve) => handle!.on('attached', () => resolve()))
  // The real browser host, with the engine preloaded (lazy loading is covered
  // by the unit tests; here we want the guest itself in the path).
  host = createToolCallHost(handle, { loadEngine: getEngine })
  return { sessionId: session.id }
}

const dispatch = (sessionId: string, script: string, vfsSeed?: Record<string, string>, executionId = 'exec-1') =>
  running!.bridge.executorFor(sessionId).dispatch({
    executionId,
    sessionId,
    tool: 'eval_script',
    input: { script },
    vfs: vfsSeed ? createVfs(vfsSeed) : undefined,
    limits: { timeoutMs: 3000 },
  })

describe('bridged execution, end to end', () => {
  it('runs a real script in the client guest and returns the value', async () => {
    const { sessionId } = await start()
    const pending = await dispatch(
      sessionId,
      `const doc = vfs.read('/leads/acme.txt')
       const revenue = Number(doc.split('revenue:')[1].trim())
       vfs.write('/out/score.json', JSON.stringify({ revenue }))
       revenue >= 100 ? 'qualified' : 'skip'`,
      { '/leads/acme.txt': 'revenue: 120' },
    )
    expect(pending).toEqual({ executionId: 'exec-1', status: 'pending' })

    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    expect(results[0]!.result).toMatchObject({ status: 'ok', output: 'qualified' })
  }, 20_000)

  it('keeps the guest sandboxed on the client side of the wire', async () => {
    const { sessionId } = await start()
    await dispatch(
      sessionId,
      `const G = ({}).constructor.constructor('return globalThis')()
       JSON.stringify({ process: typeof G.process, fetch: typeof G.fetch, ws: typeof G.WebSocket })`,
    )
    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    const result = results[0]!.result as { status: string; output: string }
    expect(result.status).toBe('ok')
    // The tab's own globals (fetch, WebSocket) are NOT reachable from the guest,
    // even though the host executing it has them.
    expect(JSON.parse(result.output)).toEqual({
      process: 'undefined',
      fetch: 'undefined',
      ws: 'undefined',
    })
  }, 20_000)

  it('returns a guest timeout as a failed result the agent can adapt to', async () => {
    const { sessionId } = await start()
    await dispatch(sessionId, 'while (true) {}')
    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    expect(results[0]!.result).toMatchObject({ status: 'failed', reason: 'timeout' })
  }, 20_000)

  it('carries guest console output back to the server', async () => {
    const { sessionId } = await start()
    await dispatch(sessionId, `console.log('working'); console.error('bad'); 1`)
    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    expect(results[0]!.result.logs).toEqual(['[log] working', '[error] bad'])
  }, 20_000)
})
