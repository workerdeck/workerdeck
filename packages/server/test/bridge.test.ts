import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerFrame, SessionInfo, ToolCallRequestFrame } from '@workerdeck/protocol'
import type { ToolExecutionResult } from '@workerdeck/core'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

/** Minimal stand-in for the SDK: the bridge tests never drive the model. */
function idleHarness() {
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => new Promise<IteratorResult<SDKMessage>>(() => {}),
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  } as unknown as Query
  return (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    void params
    return query
  }
}

function frameCollector(ws: WebSocket) {
  const frames: ServerFrame[] = []
  const waiters: Array<{ match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.match(frame)) {
        waiters[i]!.resolve(frame)
        waiters.splice(i, 1)
      }
    }
  })
  const waitFor = (match: (f: ServerFrame) => boolean, timeoutMs = 2000): Promise<ServerFrame> => {
    const existing = frames.find(match)
    if (existing) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs)
      waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) })
    })
  }
  return { frames, waitFor }
}

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
  const { port } = await running.listen(0, '127.0.0.1')
  return { base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
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

const dispatch = (sessionId: string, executionId = 'exec-1', input: unknown = { script: '1+1' }) =>
  running!.bridge.executorFor(sessionId).dispatch({
    executionId,
    sessionId,
    tool: 'eval_script',
    input,
  })

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
        type: 'tool_call_result',
        executionId: 'exec-1',
        output: { type: 'json', value: { answer: 2 } },
        logs: ['[log] computed'],
      }),
    )

    await vi.waitFor(() => expect(results).toHaveLength(1))
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
        type: 'tool_call_error',
        executionId: 'exec-1',
        reason: 'timeout',
        error: 'guest exceeded its deadline',
      }),
    )

    await vi.waitFor(() => expect(results).toHaveLength(1))
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
    await vi.waitFor(() => expect(results).toHaveLength(1))
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
        type: 'tool_call_result',
        executionId: 'exec-1',
        output: { type: 'text', value: 'too late' },
      }),
    )
    // A late answer is expected (it raced the timeout), so it must not produce a
    // protocol_error — and must not re-open the settled execution.
    await new Promise((r) => setTimeout(r, 100))
    expect(collector.frames.some((f) => f.type === 'protocol_error')).toBe(false)
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
    // Give the server a tick to process the close.
    await new Promise((r) => setTimeout(r, 50))

    const settled = await dispatch(session.id, 'exec-after-detach')
    expect(settled).toMatchObject({ status: 'settled', result: { reason: 'no_client' } })
  })

  it('fails in-flight bridged calls when the session is deleted', async () => {
    const { base, wsBase } = await startServer(5000)
    const session = await createSession(base)
    const { ws, collector } = await attach(wsBase, session.id)

    await dispatch(session.id)
    await collector.waitFor((f) => f.type === 'tool_call_request')

    await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })

    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0]!.result).toMatchObject({ status: 'failed', reason: 'session_closed' })
    ws.close()
  })
})
