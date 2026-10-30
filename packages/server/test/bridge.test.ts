import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { SessionInfo, ToolCallRequestFrame } from '@workerdeck/protocol'
import type { ToolExecutionResult } from '@workerdeck/core'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { eventually, frameCollector, idleHarness, listenOn, until } from './helpers.ts'

let running: WorkerServer | undefined
const results: Array<{ sessionId: string; executionId: string; result: ToolExecutionResult }> = []

afterEach(async () => {
  await running?.close()
  running = undefined
  results.length = 0
})

async function startServer(bridgeTimeoutMs?: number) {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: idleHarness() }),
    bridge: {
      timeoutMs: bridgeTimeoutMs,
      onResult: (sessionId, executionId, result) => results.push({ sessionId, executionId, result }),
    },
  })
  return listenOn(running)
}

async function createSession(base: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project' }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

async function attach(wsBase: string, sessionId: string) {
  const ws = new WebSocket(`${wsBase}/sessions/${sessionId}/ws`)
  const collector = frameCollector(ws)
  await collector.waitFor((f) => f.type === 'attached')
  return { ws, collector }
}

// Two refusals in turn: the second is only sent once the first came back, so anything the frames before them made the
// server send, even from a later microtask, is on the wire ahead of it.
async function roundTrips(ws: WebSocket, collector: ReturnType<typeof frameCollector>): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const seen = collector.frames.length
    ws.send(JSON.stringify({ type: 'interrupt' }))
    await collector.waitFor((f) => f.type === 'protocol_error' && collector.frames.indexOf(f) >= seen)
  }
}

function dispatch(sessionId: string, executionId = 'exec-1', input: unknown = { script: '1+1' }) {
  return running!.bridge.executorFor(sessionId).dispatch({
    executionId,
    sessionId,
    tool: 'eval_script',
    input,
  })
}

describe('browser-bridged tool execution over the wire', () => {
  it('sends a tool_call_request to the attached client and routes its answer back', async () => {
    const { base, wsBase } = await startServer()
    const session = await createSession(base)
    const { ws, collector } = await attach(wsBase, session.id)

    const pending = await dispatch(session.id)
    expect(pending).toEqual({ executionId: 'exec-1', status: 'pending' })

    const request = (await collector.waitFor((f) => f.type === 'tool_call_request')) as ToolCallRequestFrame
    expect(request).toMatchObject({
      executionId: 'exec-1',
      toolName: 'eval_script',
      input: { script: '1+1' },
    })

    ws.send(
      JSON.stringify({
        generation: 1,
        type: 'tool_call_result',
        executionId: 'exec-1',
        output: { type: 'json', value: { answer: 2 } },
        logs: ['[log] computed'],
      }),
    )

    await eventually(() => expect(results).toHaveLength(1))
    expect(results[0]).toMatchObject({
      sessionId: session.id,
      executionId: 'exec-1',
      result: { status: 'ok', output: { answer: 2 }, logs: ['[log] computed'] },
    })
    ws.close()
  })

  it('routes a client-side execution error back as a failed result', async () => {
    const { base, wsBase } = await startServer()
    const session = await createSession(base)
    const { ws, collector } = await attach(wsBase, session.id)

    await dispatch(session.id)
    await collector.waitFor((f) => f.type === 'tool_call_request')
    ws.send(
      JSON.stringify({
        generation: 1,
        type: 'tool_call_error',
        executionId: 'exec-1',
        reason: 'timeout',
        error: 'guest exceeded its deadline',
      }),
    )

    await eventually(() => expect(results).toHaveLength(1))
    expect(results[0]!.result).toMatchObject({
      status: 'failed',
      reason: 'timeout',
      error: 'guest exceeded its deadline',
    })
    ws.close()
  })

  it('fails fast when no client is attached instead of waiting for a deadline', async () => {
    const { base } = await startServer()
    const session = await createSession(base)

    const settled = await dispatch(session.id)
    expect(settled).toMatchObject({
      status: 'settled',
      result: { status: 'failed', reason: 'no_client' },
    })
  })

  it('times out a silent client and tells it to abandon the call', async () => {
    const { base, wsBase } = await startServer(150)
    const session = await createSession(base)
    const { ws, collector } = await attach(wsBase, session.id)

    await dispatch(session.id)
    await collector.waitFor((f) => f.type === 'tool_call_request')

    const canceled = await collector.waitFor((f) => f.type === 'tool_call_canceled')
    expect(canceled).toMatchObject({ executionId: 'exec-1', reason: 'timeout' })
    await eventually(() => expect(results).toHaveLength(1))
    expect(results[0]!.result).toMatchObject({ status: 'failed', reason: 'timeout' })
    ws.close()
  })

  it('ignores a late answer without erroring the client', async () => {
    const { base, wsBase } = await startServer(120)
    const session = await createSession(base)
    const { ws, collector } = await attach(wsBase, session.id)

    await dispatch(session.id)
    await collector.waitFor((f) => f.type === 'tool_call_canceled')
    expect(results).toHaveLength(1)

    ws.send(
      JSON.stringify({
        generation: 1,
        type: 'tool_call_result',
        executionId: 'exec-1',
        output: { type: 'text', value: 'too late' },
      }),
    )
    await roundTrips(ws, collector)
    expect(collector.frames.filter((f) => f.type === 'protocol_error')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('must name its conversation') }),
      expect.objectContaining({ message: expect.stringContaining('must name its conversation') }),
    ])
    expect(results).toHaveLength(1)
    ws.close()
  })

  it('stops bridging once the client detaches', async () => {
    const { base, wsBase } = await startServer()
    const session = await createSession(base)
    const { ws } = await attach(wsBase, session.id)

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve())
      ws.close()
    })
    await until(() => running!.bridge.attachedCount(session.id) === 0, 'the server to detach the socket from the bridge')

    const settled = await dispatch(session.id, 'exec-after-detach')
    expect(settled).toMatchObject({ status: 'settled', result: { reason: 'no_client' } })
  })

  it('fails in-flight bridged calls when the session is deleted', async () => {
    const { base, wsBase } = await startServer(5000)
    const session = await createSession(base)
    const { ws, collector } = await attach(wsBase, session.id)

    await dispatch(session.id)
    await collector.waitFor((f) => f.type === 'tool_call_request')

    await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE', headers: { 'x-workerdeck-generation': '1' } })

    await eventually(() => expect(results).toHaveLength(1))
    expect(results[0]!.result).toMatchObject({ status: 'failed', reason: 'session_closed' })
    ws.close()
  })
})
