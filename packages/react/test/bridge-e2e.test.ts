import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import { createVfs, loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import type { ToolExecutionResult } from '@workerdeck/core'
import { WorkerDeckClient, type SessionHandle } from '@workerdeck/client'
import { createToolCallHost } from '../src/lib/tool-host.ts'
import { eventually } from './eventually.ts'

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
async function getEngine() {
  return (engine ??= await loadEngine(variant))
}

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

async function start(guestTimeoutMs?: number) {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: idleQueryFn() }),
    bridge: {
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
  host = createToolCallHost(handle, { loadEngine: getEngine, timeoutMs: guestTimeoutMs })
  return { sessionId: session.id }
}

function dispatch(sessionId: string, script: string, vfsSeed?: Record<string, string>, executionId = 'exec-1') {
  return running!.bridge.executorFor(sessionId).dispatch({
    executionId,
    sessionId,
    tool: 'eval_script',
    input: { script },
    vfs: vfsSeed ? createVfs(vfsSeed) : undefined,
    limits: { timeoutMs: 10_000 },
  })
}

describe('bridged execution, end to end', () => {
  it('runs a real script in the client guest and returns the value', async () => {
    const { sessionId } = await start()
    const pending = await dispatch(
      sessionId,
      `const doc = vfs.read('/leads/acme.txt')
       const revenue = Number(doc.split('revenue:')[1].trim())
       vfs.write('/out/score.json', JSON.stringify({ revenue }))
       console.log('working')
       console.error('bad')
       revenue >= 100 ? 'qualified' : 'skip'`,
      { '/leads/acme.txt': 'revenue: 120' },
    )
    expect(pending).toEqual({ executionId: 'exec-1', status: 'pending' })

    await eventually(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    expect(results[0]!.result).toEqual({ status: 'ok', output: 'qualified', logs: ['[log] working', '[error] bad'] })
  }, 20_000)

  it('keeps the guest sandboxed on the client side of the wire', async () => {
    const { sessionId } = await start()
    await dispatch(
      sessionId,
      `const G = ({}).constructor.constructor('return globalThis')()
       JSON.stringify({ process: typeof G.process, fetch: typeof G.fetch, ws: typeof G.WebSocket })`,
    )
    await eventually(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    const result = results[0]!.result as { status: string; output: string }
    expect(result.status).toBe('ok')
    expect(JSON.parse(result.output)).toEqual({
      process: 'undefined',
      fetch: 'undefined',
      ws: 'undefined',
    })
  }, 20_000)

  it('returns a guest timeout, with what the guest logged, as a failed result the agent can adapt to', async () => {
    const { sessionId } = await start(50)
    await dispatch(sessionId, "console.log('spinning'); while (true) {}")
    await eventually(() => expect(results).toHaveLength(1), { timeout: 15_000 })
    expect(results[0]!.result).toEqual({ status: 'failed', reason: 'timeout', error: 'InternalError: interrupted', logs: ['[log] spinning'] })
  }, 20_000)
})
