// Shared fakes for the gateway suites. Every one of these existed in two to four copies
// before; `parkable-runner.ts` next door is the same idea for the parking suites.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type WebSocket from 'ws'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import type { ServerFrame, SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import type { WorkerServer } from '../src/index.ts'

// Controllable stand-in for the Claude Agent SDK. `models` makes the fake query answer
// `supportedModels`, which is what makes a runner emit `capabilities`.
export function fakeHarness(models?: Array<Record<string, unknown>>) {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const captured: { options?: Options; inputs: SDKUserMessage[] } = { inputs: [] }
  const interrupt = vi.fn(async () => {})
  const stopTask = vi.fn(async (_taskId: string) => {})
  const setModel = vi.fn(async () => {})

  const emit = (msg: SDKMessage) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else {
      messages.push(msg)
    }
  }
  const end = () => {
    done = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: undefined, done: true })
    }
  }
  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const buffered = messages.shift()
      if (buffered !== undefined) {
        return Promise.resolve({ value: buffered, done: false })
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt,
    stopTask,
    setModel,
    close: end,
    ...(models
      ? {
          supportedModels: vi.fn(async () => models),
          supportedCommands: vi.fn(async () => []),
        }
      : {}),
  } as unknown as Query

  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    captured.options = params.options
    void (async () => {
      for await (const input of params.prompt as AsyncIterable<SDKUserMessage>) {
        captured.inputs.push(input)
      }
    })()
    return query
  }
  return { emit, end, captured, interrupt, stopTask, setModel, queryFn }
}

// A query that never yields - for suites where the claude sessions are only ever built.
export function idleQuery(): Query {
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => new Promise<never>(() => {}),
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  } as unknown as Query
}

// The `queryFn` form of {@link idleQuery}.
export function idleHarness() {
  const query = idleQuery()
  return (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    void params
    return query
  }
}

// Buffer every frame a socket receives and let a test await the first one that matches.
// Matching against already-buffered frames is the point: attach races the assertion.
export function frameCollector(ws: WebSocket) {
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
      waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
      })
    })
  }
  return { frames, waitFor }
}

// A Runner that does nothing but echo its config back through `info()` - scope and title
// included, which is exactly what `buildRunner` and the scope suites assert on.
export function fakeRunner(id: string, config: SessionRunnerConfig): Runner {
  let title: string | undefined
  return {
    id,
    pendingApprovals: [],
    start: async () => {},
    info: (): SessionInfo => ({
      id,
      status: 'idle',
      cwd: config.cwd ?? '',
      profile: config.profile,
      model: config.model,
      createdAt: Date.now(),
      lastSeq: 0,
      pendingPermissionCount: 0,
      scope: config.scope,
      title,
    }),
    subscribe: () => () => {},
    sendMessage: () => {},
    setTitle: (next) => {
      title = next
    },
    resolvePermission: () => false,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    fail: () => {},
    close: () => {},
  }
}

// Gateways and state dirs torn down together after each test. `servers` is exposed so a test that closes one itself
// can take it off the list first.
export function gatewayFixture(prefix: string) {
  const servers: WorkerServer[] = []
  const dirs: string[] = []
  const stateDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
  const cleanup = async (): Promise<void> => {
    for (const server of servers.splice(0)) {
      await server.close()
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  }
  return { servers, stateDir, cleanup }
}

// Bind a server to an ephemeral loopback port and hand back both API roots.
export async function listenOn(server: WorkerServer): Promise<{ base: string; wsBase: string }> {
  const { port } = await server.listen(0, '127.0.0.1')
  return { base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

// A runner whose log a test writes by hand: `emitAt` takes an explicit event timestamp, because some rules under test
// order by event clock rather than arrival. `identity` is merged over the idle `info()`.
export class ScriptedRunner implements Runner {
  readonly id: string
  readonly createdAt = Date.now()
  readonly pendingApprovals = []
  readonly config: SessionRunnerConfig
  #identity: Partial<SessionInfo>
  #events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0

  constructor(id: string, config: SessionRunnerConfig, identity: Partial<SessionInfo> = {}) {
    this.id = id
    this.config = config
    this.#identity = identity
  }

  async start(): Promise<void> {}
  info(): SessionInfo {
    return {
      id: this.id,
      status: 'idle',
      cwd: this.config.cwd ?? '',
      profile: this.config.profile,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      ...this.#identity,
    }
  }
  subscribe(listener: (event: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) {
        listener(event)
      }
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  sendMessage(): void {}
  setTitle(): void {}
  resolvePermission(): boolean {
    return false
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  close(): void {}

  emitAt(body: SessionEventBody, ts = Date.now()): void {
    const event = { ...body, seq: ++this.#seq, ts } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
}
