import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionInfo, SessionNotification } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

/** The SDK stand-in: tests push messages in and hold `canUseTool` to raise a
 * permission request, which is the notification that matters most. */
function fakeHarness() {
  const buffered: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  const captured: { options?: Options } = {}

  const emit = (msg: SDKMessage) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else {
      buffered.push(msg)
    }
  }
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const next = buffered.shift()
      if (next !== undefined) return Promise.resolve({ value: next, done: false })
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  } as unknown as Query

  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    captured.options = params.options
    void (async () => {
      for await (const _ of params.prompt as AsyncIterable<SDKUserMessage>) {
        // drained so the runner's input queue doesn't block
      }
    })()
    return query
  }
  return { emit, captured, queryFn }
}

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

/** A webhook receiver that records what it was POSTed. */
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
      // The whole request rides along: without its id a lock-screen Approve action
      // has nothing to POST to.
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

      // The local observer sees everything the webhook does.
      expect(observed.map((n) => n.type)).toEqual(
        expect.arrayContaining(['permission_requested', 'turn_completed']),
      )
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
        expect(observed.map((n) => n.type)).toEqual(
          expect.arrayContaining(['turn_completed', 'permission_requested']),
        ),
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

      // Two rejections, then the third attempt lands — same notification each time.
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
    // The turn still lands; there is simply nowhere for it to be announced.
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/sessions/${session.id}`)
      // 2 = the turn_result's own num_turns, which SessionInfo accumulates.
      expect(((await res.json()) as { session: SessionInfo }).session.numTurns).toBe(2)
    })
  })
})
