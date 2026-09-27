import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent, SessionInfo, SessionNotification } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { SessionNotifier, type NotificationErrorContext } from '../src/services/notifications.ts'
import { fakeHarness, fakeRunner } from './helpers.ts'

const turnResult = {
  type: 'result',
  subtype: 'success',
  duration_ms: 500,
  duration_api_ms: 400,
  is_error: false,
  num_turns: 2,
  result: 'all done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.02,
  usage: { input_tokens: 10, output_tokens: 5 },
  session_id: 'sdk-1',
  uuid: 'uuid-result',
} as unknown as SDKMessage

async function startReceiver(respond: () => number = () => 200) {
  const received: SessionNotification[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SessionNotification)
      res.writeHead(respond()).end()
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return {
    received,
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function createSession(base: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', prompt: 'go' }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session
}

describe('session notifications', () => {
  it('delivers permission requests and turn completions to the webhook', async () => {
    const receiver = await startReceiver()
    const harness = fakeHarness()
    const observed: SessionNotification[] = []
    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        notifications: {
          webhook: { url: receiver.url, headers: { 'x-token': 'secret' } },
          onNotification: (n) => observed.push(n),
        },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`
      const session = await createSession(base)

      await vi.waitFor(() => expect(harness.captured.options?.canUseTool).toBeDefined())
      void harness.captured.options!.canUseTool!(
        'Bash',
        { command: 'rm -rf /' },
        { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-1' },
      )
      harness.emit(turnResult)

      await vi.waitFor(() => expect(receiver.received.length).toBeGreaterThanOrEqual(2))

      const permission = receiver.received.find((n) => n.type === 'permission_requested')!
      expect(permission.sessionId).toBe(session.id)
      expect(permission.preview).toBe('Bash')
      expect(permission.request?.toolName).toBe('Bash')
      expect(permission.request?.id).toBeTruthy()
      expect(permission.seq).toBeGreaterThan(0)
      expect(permission.session.id).toBe(session.id)

      const completed = receiver.received.find((n) => n.type === 'turn_completed')!
      expect(completed.preview).toBe('all done')
      expect(completed.result).toEqual({
        isError: false,
        durationMs: 500,
        numTurns: 2,
        totalCostUsd: 0.02,
      })

      expect(observed.map((n) => n.type)).toEqual(expect.arrayContaining(['permission_requested', 'turn_completed']))
    } finally {
      await receiver.close()
    }
  })

  it('honours the events filter for deliveries but not for the observer', async () => {
    const receiver = await startReceiver()
    const harness = fakeHarness()
    const observed: SessionNotification[] = []
    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        notifications: {
          webhook: { url: receiver.url, events: ['permission_requested'] },
          onNotification: (n) => observed.push(n),
        },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`
      const session = await createSession(base)

      await vi.waitFor(() => expect(harness.captured.options?.canUseTool).toBeDefined())
      harness.emit(turnResult)
      void harness.captured.options!.canUseTool!(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-1' },
      )

      await vi.waitFor(() => expect(receiver.received.length).toBe(1))
      await vi.waitFor(() =>
        expect(observed.map((n) => n.type)).toEqual(expect.arrayContaining(['turn_completed', 'permission_requested'])),
      )
      expect(receiver.received.map((n) => n.type)).toEqual(['permission_requested'])
      expect(receiver.received[0]!.sessionId).toBe(session.id)
    } finally {
      await receiver.close()
    }
  })

  it('reports a closed session and stops there', async () => {
    const receiver = await startReceiver()
    const harness = fakeHarness()
    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        notifications: { webhook: { url: receiver.url, events: ['session_closed'] } },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`
      const session = await createSession(base)

      expect((await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })).status).toBe(200)
      await vi.waitFor(() => expect(receiver.received.length).toBe(1))
      expect(receiver.received[0]!.type).toBe('session_closed')
      expect(receiver.received[0]!.reason).toBe('server')
      expect(receiver.received[0]!.session.status).toBe('closed')
    } finally {
      await receiver.close()
    }
  })

  it('retries a failing delivery and gives up without disturbing the session', async () => {
    let calls = 0
    const receiver = await startReceiver(() => (calls++ < 2 ? 500 : 200))
    const harness = fakeHarness()
    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        notifications: {
          webhook: { url: receiver.url, events: ['turn_completed'] },
          attempts: 3,
          retryDelayMs: 1,
        },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`
      const session = await createSession(base)

      await vi.waitFor(() => expect(harness.captured.options?.canUseTool).toBeDefined())
      harness.emit(turnResult)

      await vi.waitFor(() => expect(receiver.received.length).toBe(3))
      expect(new Set(receiver.received.map((n) => n.type))).toEqual(new Set(['turn_completed']))
      expect((await fetch(`${base}/sessions/${session.id}`)).status).toBe(200)
    } finally {
      await receiver.close()
    }
  })

  it('stays out of the way when nothing is configured', async () => {
    const harness = fakeHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const session = await createSession(base)
    harness.emit(turnResult)
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/sessions/${session.id}`)
      // 2 = the turn_result's own num_turns, which SessionInfo accumulates.
      expect(((await res.json()) as { session: SessionInfo }).session.numTurns).toBe(2)
    })
  })
})

describe('SessionNotifier diagnostics', () => {
  function emittingRunner() {
    let listener: ((event: SessionEvent) => void) | undefined
    const runner = {
      ...fakeRunner('s1', { cwd: '/tmp' }),
      subscribe: (next: (event: SessionEvent) => void) => {
        listener = next
        return () => {}
      },
    }
    const emit = () => listener?.({ type: 'session_error', message: 'boom', seq: 1, ts: Date.now() } as SessionEvent)
    return { runner, emit }
  }

  it('hands a throwing hook and an exhausted webhook to onError instead of swallowing them', async () => {
    const errors: { op: string; message: string }[] = []
    const onError = (error: unknown, context: NotificationErrorContext) =>
      errors.push({ op: context.op, message: error instanceof Error ? error.message : String(error) })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }))
    try {
      const notifier = new SessionNotifier({
        webhook: { url: 'http://127.0.0.1:9/hook' },
        attempts: 2,
        retryDelayMs: 1,
        onNotification: () => {
          throw new Error('hook failed')
        },
        onError,
      })
      const { runner, emit } = emittingRunner()
      notifier.watch(runner)
      emit()
      await vi.waitFor(() => expect(errors).toHaveLength(2))
      expect(errors).toEqual([
        { op: 'hook', message: 'hook failed' },
        { op: 'webhook', message: 'webhook answered HTTP 500' },
      ])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      fetchMock.mockRestore()
    }
  })
})
