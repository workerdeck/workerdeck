import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createWorkerServer, type WorkerServer } from '@workerdeck/server'
import type { ToolExecutionResult } from '@workerdeck/core'
import { WorkerDeckClient, type SessionHandle } from '../src/index.ts'
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

let running: WorkerServer | undefined
let handle: SessionHandle | undefined
const results: Array<{ executionId: string; result: ToolExecutionResult }> = []

afterEach(async () => {
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
      onResult: (_sessionId, executionId, result) => results.push({ executionId, result }),
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
  return { client, sessionId: session.id, handle: handle! }
}

const SEED = { '/doc.txt': 'body' }

function dispatch(sessionId: string, executionId = 'exec-1', seed?: Record<string, string>) {
  return running!.bridge.executorFor(sessionId).dispatch({
    executionId,
    sessionId,
    tool: 'eval_script',
    input: { script: '1+1' },
    vfs: seed && { read: () => undefined, write: () => {}, list: () => [], snapshot: () => seed },
  })
}

describe('SessionHandle tool-call bridge', () => {
  it('surfaces a bridged request and round-trips a result', async () => {
    const { sessionId, handle } = await start()
    const requests: Array<{ executionId: string; toolName: string; vfsSeed?: Record<string, string> }> = []
    handle.on('toolCallRequest', (frame) => {
      requests.push({ executionId: frame.executionId, toolName: frame.toolName, vfsSeed: frame.vfsSeed })
      handle.sendToolCallResult(frame.executionId, { type: 'json', value: { answer: 2 } }, ['[log] ok'])
    })

    const pending = await dispatch(sessionId, 'exec-1', SEED)
    expect(pending).toEqual({ executionId: 'exec-1', status: 'pending' })

    await eventually(() => expect(results).toHaveLength(1))
    expect(requests).toEqual([{ executionId: 'exec-1', toolName: 'eval_script', vfsSeed: { '/doc.txt': 'body' } }])
    expect(results[0]).toMatchObject({
      executionId: 'exec-1',
      result: { status: 'ok', output: { answer: 2 }, logs: ['[log] ok'] },
    })
  })

  it('reports a client-side failure so the agent can adapt', async () => {
    const { sessionId, handle } = await start()
    handle.on('toolCallRequest', (frame) => {
      handle.sendToolCallError(frame.executionId, 'unsupported_tool', 'this client cannot run that')
    })

    await dispatch(sessionId)
    await eventually(() => expect(results).toHaveLength(1))
    expect(results[0]!.result).toMatchObject({
      status: 'failed',
      reason: 'unsupported_tool',
      error: 'this client cannot run that',
    })
  })

  it('receives a cancellation when the server gives up waiting', async () => {
    const { sessionId, handle } = await start(20)
    const canceled: Array<{ executionId: string; reason: string }> = []
    // Deliberately never answer.
    handle.on('toolCallRequest', () => {})
    handle.on('toolCallCanceled', (payload) => canceled.push(payload))

    await dispatch(sessionId)
    await eventually(() => expect(canceled).toHaveLength(1))
    expect(canceled[0]).toMatchObject({ executionId: 'exec-1', reason: 'timeout' })
    expect(results[0]!.result).toMatchObject({ status: 'failed', reason: 'timeout' })
  })
})
