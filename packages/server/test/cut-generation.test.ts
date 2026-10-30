import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentInput, EngineAdapter, SendMessageOptions, SessionRunnerConfig } from '@workerdeck/core'
import {
  CONVERSATION_ENDED_CLOSE_CODE,
  UNCERTAIN_PROMPT_CODE,
  ENGINE_CAPABILITIES,
  type ProfileInfo,
  type ServerFrame,
  type SessionInfo,
  type SessionNotification,
} from '@workerdeck/protocol'
import {
  createFileSessionRecordStore,
  createWorkerServer,
  type SessionRecordStore,
  type WorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import { WOKE_DURING_CUT } from '../src/services/conversation-cuts.ts'
import { CUT_IN_PROGRESS } from '../src/services/lifecycle-locks.ts'
import { EngineRunner } from './engine-runner.ts'
import { deferred, eventually, frameCollector, gatewayFixture, settled, until } from './helpers.ts'

const PROFILES: ProfileInfo[] = [{ name: 'claude-a', engine: 'claude', configDir: '/tmp' }]

const PRINCIPALS: Record<string, unknown> = {
  'tenant-a': { scope: { tenant: 'a' }, allowedProfiles: ['claude-a'] },
  'tenant-b': { scope: { tenant: 'b' }, allowedProfiles: ['claude-a'] },
}

const fixture = gatewayFixture('wd-cutgen-')
afterEach(fixture.cleanup)

// Records every mutation it is asked for, holds a permission request on demand, and answers nothing until told.
class Engine extends EngineRunner {
  readonly calls: string[] = []
  readonly approvals: string[] = []
  #pending = 0
  #inputs = 0
  #peer = false
  #nonce = Math.random().toString(36).slice(2)

  override info(): SessionInfo {
    const info = super.info()
    return {
      ...info,
      engine: 'claude',
      capabilities: { ...ENGINE_CAPABILITIES.claude, resume: true },
      ...(this.approvals.length > 0 && info.status === 'idle' ? { status: 'awaiting_approval' as const } : {}),
      pendingPermissionCount: this.approvals.length,
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  override sendMessage(text: string, _attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    super.sendMessage(text)
    if (this.answering) {
      return
    }
    this.#pending++
    this.#inputs++
    this.#peer ||= options?.origin !== undefined
  }

  // Off: every send stays unanswered until `answer()`, as a busy engine's queue would hold it.
  answering = true

  answer(): void {
    this.#pending = 0
    this.#peer = false
  }

  pendingInput(): number {
    return this.#pending
  }

  inputSnapshot(): { revision: string; pending: number; peer: boolean } {
    return { revision: `${this.#nonce}.${this.#inputs}`, pending: this.#pending, peer: this.#peer }
  }

  ask(requestId: string): void {
    this.approvals.push(requestId)
    this.emit({ type: 'status_changed', status: 'awaiting_approval' })
  }

  override resolvePermission(requestId?: string): boolean {
    this.calls.push(`permission:${requestId}`)
    const index = this.approvals.indexOf(requestId ?? '')
    if (index < 0) {
      return false
    }
    this.approvals.splice(index, 1)
    this.emit({ type: 'status_changed', status: 'idle' })
    return true
  }

  override setTitle(title?: string): void {
    this.calls.push(`title:${title}`)
  }

  override async interrupt(): Promise<void> {
    this.calls.push('interrupt')
  }

  override async setModel(model?: string): Promise<void> {
    this.calls.push(`model:${model}`)
  }

  async sleep(): Promise<{ ok: true }> {
    this.calls.push('sleep')
    return { ok: true }
  }

  async stopTask(id: string): Promise<boolean> {
    this.calls.push(`stop:${id}`)
    return true
  }

  async backgroundTask(id?: string): Promise<boolean> {
    this.calls.push(`background:${id}`)
    return true
  }

  override close(): void {
    this.calls.push('close')
    super.close()
  }
}

type Hooks = { options?: Partial<WorkerServerOptions>; store?: SessionRecordStore; scoped?: boolean; building?: (runner: Engine) => void }

async function gateway(dir: string, hooks: Hooks = {}) {
  const built: Engine[] = []
  const adapter: EngineAdapter = {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }: { config: SessionRunnerConfig; id?: string }) => {
      const runner = new Engine(id ?? `s${built.length + 1}-${dir.slice(-6)}`, config)
      built.push(runner)
      hooks.building?.(runner)
      return runner
    },
  }
  const server: WorkerServer = createWorkerServer({
    ...(hooks.scoped
      ? {
          authenticate: (req) => {
            const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
            return token === 'operator' ? { operator: true } : (PRINCIPALS[token] ?? null)
          },
        }
      : { allowUnauthenticated: true }),
    allowedCwdRoots: ['/tmp'],
    profiles: PROFILES,
    engines: { claude: adapter },
    sessions: { store: hooks.store ?? createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
    parking: { parkDelayMs: 10 },
    historyReader: { read: async () => ({ kind: 'missing' }) },
    ...hooks.options,
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, built, base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

type Call = { status: number; body: Record<string, any> }

async function call(base: string, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}): Promise<Call> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

function generation(n: number): Record<string, string> {
  return { 'x-workerdeck-generation': String(n) }
}

async function create(base: string, extra: Record<string, unknown> = {}, token?: string): Promise<string> {
  const res = await call(
    base,
    '/sessions',
    'POST',
    { cwd: '/tmp', profile: 'claude-a', prompt: 'work', ...extra },
    token ? bearer(token) : {},
  )
  expect(res.status).toBe(201)
  return (res.body.session as SessionInfo).id
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function cut(base: string, id: string, expectedGeneration: number, token?: string): Promise<Call> {
  return await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration }, token ? bearer(token) : {})
}

async function attach(wsBase: string, id: string) {
  const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
  const frames = frameCollector(ws)
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  await frames.waitFor((frame) => frame.type === 'attached')
  return { ws, frames, closed, send: (frame: Record<string, unknown>) => ws.send(JSON.stringify(frame)) }
}

function ackOf(
  frames: { waitFor: (match: (frame: ServerFrame) => boolean) => Promise<ServerFrame> },
  clientId: string,
): Promise<ServerFrame> {
  return frames.waitFor((frame) => frame.type === 'ack' && frame.clientId === clientId)
}

function sentEverywhere(built: Engine[]): string[] {
  return built.flatMap((runner) => runner.sent)
}

// Holds the first record save that matches, so a test can act at that exact point of a cut.
function holdingStore(dir: string, matches: (record: Parameters<SessionRecordStore['save']>[0]) => boolean) {
  const inner = createFileSessionRecordStore({ dir: join(dir, 'sessions') })
  const reached = deferred()
  const released = deferred()
  let held = false
  const store: SessionRecordStore = {
    ...inner,
    save: async (record) => {
      if (!held && matches(record)) {
        held = true
        reached.resolve()
        await released.promise
      }
      await inner.save(record)
    },
  }
  return { store, reached: reached.promise, release: released.resolve }
}

// Joins the socket's prompt queue: its ack proves every prompt sent before it was handled. The unknown attachment keeps
// it from ever reaching the runner.
async function drained(socket: Awaited<ReturnType<typeof attach>>, clientId: string, conversation = 1): Promise<void> {
  socket.send({ generation: conversation, type: 'user_message', text: 'probe', clientId, attachmentIds: ['none'] })
  expect(await ackOf(socket.frames, clientId)).toEqual({ type: 'ack', clientId, notDelivered: true })
}

describe('a socket is bound to the conversation it attached to', () => {
  it('runs nothing a socket on n sends once the cut has begun, and closes it with the new conversation named', async () => {
    const dir = await fixture.stateDir()
    const { store, reached, release } = holdingStore(dir, (record) => record.cut?.phase === 'committed' && record.cut.from > 0)
    const { server, base, wsBase, built } = await gateway(dir, { store })
    const id = await create(base)
    await settled(server, id)
    const old = await attach(wsBase, id)

    const pending = cut(base, id, 1)
    await reached
    old.send({ generation: 1, type: 'user_message', text: 'mid-cut', clientId: 'm-1' })
    expect(await ackOf(old.frames, 'm-1')).toEqual({ type: 'ack', clientId: 'm-1', notDelivered: true })
    old.send({ generation: 1, type: 'interrupt' })
    old.send({ generation: 1, type: 'set_model', model: 'other' })
    await until(
      () => old.frames.frames.filter((frame) => frame.type === 'protocol_error' && frame.message === CUT_IN_PROGRESS).length === 3,
      'the gated refusals',
    )
    release()
    expect((await pending).status).toBe(200)

    const started = await old.frames.waitFor((frame) => (frame.type as string) === 'conversation_started')
    expect(started).toMatchObject({ conversation: 2 })
    expect(await old.closed).toBe(CONVERSATION_ENDED_CLOSE_CODE)
    await settled(server, id)
    expect(sentEverywhere(built)).toEqual(['work'])
    expect(built.flatMap((runner) => runner.calls).filter((entry) => entry !== 'close')).toEqual([])
  })

  it('refuses every command an n socket sends after the cut, whatever generation it claims', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await settled(server, id)
    const old = await attach(wsBase, id)
    const started = old.frames.waitFor((frame) => (frame.type as string) === 'conversation_started')
    expect((await cut(base, id, 1)).status).toBe(200)
    await started
    // Sent the moment the announce lands, before the close completes: the socket is still bound to the stopped runner.
    old.send({ generation: 1, type: 'user_message', text: 'stale', clientId: 's-1' })
    old.send({ generation: 2, type: 'user_message', text: 'claims n+1', clientId: 's-2' })
    old.send({ generation: 2, type: 'interrupt' })
    expect(await old.closed).toBe(CONVERSATION_ENDED_CLOSE_CODE)
    await settled(server, id)
    expect(built.at(-1)!.sent).toEqual([])
    expect(built.at(-1)!.calls).toEqual([])
    expect(built[0]!.sent).toEqual(['work'])
  })

  it('attaches a socket opened before the stop to n, then announces and closes it like any other', async () => {
    const dir = await fixture.stateDir()
    const { store, reached, release } = holdingStore(dir, (record) => record.cut?.phase === 'prepared' && record.cut.from > 0)
    const { server, base, wsBase, built } = await gateway(dir, { store })
    const id = await create(base)
    await settled(server, id)
    const pending = cut(base, id, 1)
    await reached
    const late = await attach(wsBase, id)
    late.send({ generation: 1, type: 'user_message', text: 'mid-cut', clientId: 'l-1' })
    expect(await ackOf(late.frames, 'l-1')).toMatchObject({ notDelivered: true })
    release()
    expect((await pending).status).toBe(200)
    expect(await late.frames.waitFor((frame) => (frame.type as string) === 'conversation_started')).toMatchObject({ conversation: 2 })
    expect(await late.closed).toBe(CONVERSATION_ENDED_CLOSE_CODE)
    await settled(server, id)
    expect(sentEverywhere(built)).toEqual(['work'])
  })

  it('refuses an upgrade that arrives between the stop and the commit with 503, never attaching it to n', async () => {
    const dir = await fixture.stateDir()
    const { store, reached, release } = holdingStore(dir, (record) => record.cut?.phase === 'committed' && record.cut.from > 0)
    const { server, base, wsBase, built } = await gateway(dir, { store })
    const id = await create(base)
    await settled(server, id)
    const pending = cut(base, id, 1)
    await reached
    const upgrading = deferred()
    const lookup = server.parking.get.bind(server.parking)
    vi.spyOn(server.parking, 'get').mockImplementation((key) => {
      upgrading.resolve()
      return lookup(key)
    })
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const outcome = new Promise<string>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`))
      ws.on('open', () => resolve('attached'))
    })
    await upgrading.promise
    release()
    expect((await pending).status).toBe(200)
    expect(await outcome).toBe('refused 503')
    await settled(server, id)
    expect(built).toHaveLength(2)
    expect(built[0]!.sent).toEqual(['work'])
  })

  it('binds a socket opened while n+1 starts to n+1: its commands wait for the start, and the announce leaves it open', async () => {
    const dir = await fixture.stateDir()
    const start = deferred()
    const { server, base, wsBase, built } = await gateway(dir, {
      building: (runner) => {
        if (runner.config.epoch !== undefined && runner.config.epoch > 0) {
          runner.hold = start.promise
        }
      },
    })
    const id = await create(base)
    await settled(server, id)
    const pending = cut(base, id, 1)
    await eventually(() => expect(built).toHaveLength(2))
    const late = await attach(wsBase, id)
    const attached = late.frames.frames.find((frame) => frame.type === 'attached') as Extract<ServerFrame, { type: 'attached' }>
    expect(attached.session.epoch).toBe(built[1]!.config.epoch)
    late.send({ generation: 1, type: 'user_message', text: 'for n', clientId: 'n-1' })
    expect(await ackOf(late.frames, 'n-1')).toMatchObject({ uncertain: true })
    late.send({ generation: 2, type: 'user_message', text: 'too early', clientId: 'n-2' })
    expect(await ackOf(late.frames, 'n-2')).toMatchObject({ notDelivered: true })
    start.resolve()
    expect((await pending).status).toBe(200)
    await settled(server, id)
    expect(built[0]!.sent).toEqual(['work'])
    expect(built[1]!.sent).toEqual([])
    const fresh = await attach(wsBase, id)
    fresh.send({ generation: 2, type: 'user_message', text: 'now', clientId: 'n-3' })
    expect(await ackOf(fresh.frames, 'n-3')).toEqual({ type: 'ack', clientId: 'n-3' })
    expect(built[1]!.sent).toEqual(['now'])
    late.send({ generation: 2, type: 'user_message', text: 'late socket', clientId: 'n-4' })
    expect(await ackOf(late.frames, 'n-4')).toEqual({ type: 'ack', clientId: 'n-4' })
    expect(late.frames.frames.some((frame) => (frame.type as string) === 'conversation_started')).toBe(false)
    expect(built[1]!.sent).toEqual(['now', 'late socket'])
    fresh.ws.close()
    late.ws.close()
  })

  it('lets an untokened shell_attach only subscribe: it never resizes, and every other untokened shell command is refused', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir, { options: { shell: { enabled: true } } })
    const id = await create(base)
    await settled(server, id)
    const shells = server.shells!
    const runner = built[0]!
    const spawned = await shells.spawn({ runner: runner as never, command: 'sleep 5', owner: 'user' })
    const shellId = spawned.source.info().id
    const before = { cols: spawned.source.info().cols, rows: spawned.source.info().rows }
    const socket = await attach(wsBase, id)

    socket.send({ type: 'shell_attach', shellId, cols: 33, rows: 11 })
    const attached = (await socket.frames.waitFor((frame) => frame.type === 'shell_attached')) as Extract<
      ServerFrame,
      { type: 'shell_attached' }
    >
    expect({ cols: attached.cols, rows: attached.rows }).toEqual(before)
    expect(shells.get(id, shellId)).toMatchObject(before)

    socket.send({ type: 'shell_resize', shellId, cols: 44, rows: 12 })
    expect(await socket.frames.waitFor((frame) => frame.type === 'protocol_error')).toMatchObject({
      message: expect.stringContaining('must name its conversation'),
    })
    expect(shells.get(id, shellId)).toMatchObject(before)

    socket.send({ type: 'shell_attach', shellId, cols: 55, rows: 13, generation: 1 })
    await eventually(() => expect(shells.get(id, shellId)).toMatchObject({ cols: 55, rows: 13 }))
    shells.kill(id, shellId)
    socket.ws.close()
  })
})

type RouteCase = {
  name: string
  method: string
  path: (id: string, shellId: string) => string
  body?: unknown
  contentType?: string
  ok: number
}

const ROUTES: RouteCase[] = [
  { name: 'PATCH a title', method: 'PATCH', path: (id) => `/sessions/${id}`, body: { title: 'late' }, ok: 200 },
  { name: 'a permission decision', method: 'POST', path: (id) => `/sessions/${id}/permissions/p-1`, body: { behavior: 'allow' }, ok: 200 },
  {
    name: 'an attachment upload',
    method: 'POST',
    path: (id) => `/sessions/${id}/attachments?name=a.txt`,
    body: 'hello',
    contentType: 'text/plain',
    ok: 201,
  },
  { name: 'a shell kill', method: 'POST', path: (id, shell) => `/sessions/${id}/shells/${shell}/kill`, ok: 200 },
  {
    name: 'a shell agent-write toggle',
    method: 'POST',
    path: (id, shell) => `/sessions/${id}/shells/${shell}/agent-write`,
    body: { enabled: false },
    ok: 200,
  },
  { name: 'a sleep', method: 'POST', path: (id) => `/sessions/${id}/sleep`, ok: 200 },
  { name: 'a task stop', method: 'POST', path: (id) => `/sessions/${id}/tasks/t-1/stop`, ok: 200 },
  { name: 'a task to the background', method: 'POST', path: (id) => `/sessions/${id}/tasks/t-1/background`, ok: 200 },
  { name: 'a DELETE', method: 'DELETE', path: (id) => `/sessions/${id}`, ok: 200 },
]

async function raw(base: string, route: RouteCase, id: string, shellId: string, headers: Record<string, string>): Promise<Call> {
  const body = route.body === undefined ? undefined : typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
  const res = await fetch(`${base}${route.path(id, shellId)}`, {
    method: route.method,
    headers: { 'content-type': route.contentType ?? 'application/json', ...headers },
    ...(body === undefined ? {} : { body }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

describe('every mutating route names its conversation', () => {
  it.each(ROUTES)('refuses $name untokened, stale after a move, or ahead, with 409 and no side effect', async (route) => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir, { options: { shell: { enabled: true } } })
    const id = await create(base)
    await settled(server, id)
    expect((await cut(base, id, 1)).status).toBe(200)
    await settled(server, id)
    const current = built[1]!
    current.ask('p-1')
    const shell = await server.shells!.spawn({ runner: current as never, command: 'sleep 5', owner: 'user' })
    const shellId = shell.source.info().id
    const titleBefore = (await server.records.get(id))?.runtime?.info.title

    for (const headers of [{}, generation(1), generation(3), { 'x-workerdeck-generation': 'two' }]) {
      const refused = await raw(base, route, id, shellId, headers)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toMatch(/conversation/)
    }
    expect(current.calls).toEqual([])
    expect(current.approvals).toHaveLength(1)
    expect(server.shells!.get(id, shellId)?.status).toBe('running')
    expect(server.registry.get(id)).toBe(current)
    const record = await server.records.get(id)
    expect(record).toMatchObject({ conversation: 2 })
    expect(record?.closedAt).toBeUndefined()
    expect(record?.runtime?.info.title).toBe(titleBefore)
    expect(built).toHaveLength(2)
    expect(built[0]!.calls).toEqual(['close'])

    const accepted = await raw(base, route, id, shellId, generation(2))
    expect(accepted.status).toBe(route.ok)
    server.shells!.kill(id, shellId)
  })
})

const WS_COMMANDS: Array<Record<string, unknown>> = [
  { type: 'user_message', text: 'hello' },
  { type: 'interrupt' },
  { type: 'permission_decision', requestId: 'p-1', behavior: 'allow' },
  { type: 'sleep' },
  { type: 'set_model', model: 'other' },
  { type: 'set_permission_mode', mode: 'default' },
  { type: 'set_effort', effort: 'high' },
  { type: 'background_task', toolUseId: 't-1' },
  { type: 'tool_call_result', executionId: 'x-1', output: {} },
  { type: 'shell_command', command: 'echo hi' },
  { type: 'shell_input', shellId: 'sh-1', data: 'x' },
  { type: 'shell_resize', shellId: 'sh-1', cols: 10, rows: 10 },
  { type: 'clear_context' },
  { type: 'user_message', text: '/clear' },
  { type: 'close' },
]

describe('every socket command names its conversation', () => {
  it('refuses each command untokened, stale after a move, or ahead, and runs none of them', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir, { options: { shell: { enabled: true } } })
    const id = await create(base)
    await settled(server, id)
    expect((await cut(base, id, 1)).status).toBe(200)
    await settled(server, id)
    const current = built[1]!
    current.ask('p-1')
    const socket = await attach(wsBase, id)
    let expected = 0
    for (const command of WS_COMMANDS) {
      for (const stamp of [{}, { generation: 1 }, { generation: 3 }, { generation: '2' }]) {
        socket.send({ ...command, ...stamp })
        expected++
      }
    }
    await until(
      () => socket.frames.frames.filter((frame) => frame.type === 'protocol_error').length === expected,
      'a refusal for every command',
    )
    expect(current.sent).toEqual([])
    expect(current.calls).toEqual([])
    expect(current.approvals).toHaveLength(1)
    expect(server.registry.get(id)).toBe(current)
    expect((await server.records.get(id))?.conversation).toBe(2)
    expect(server.shells!.list(id)).toEqual([])
    expect(built).toHaveLength(2)
    socket.ws.close()
  })
})

describe('permissions across the cut', () => {
  it('holds the cut while a permission is pending at n, and refuses a late decision for it once n+1 runs', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await settled(server, id)
    const first = built[0]!
    const old = await attach(wsBase, id)
    first.ask('p-1')
    const busy = await cut(base, id, 1)
    expect(busy).toMatchObject({ status: 409, body: { error: expect.stringContaining('busy') } })
    old.send({ generation: 1, type: 'clear_context' })
    await until(() => server.cuts.queued(id), 'the clear to queue behind the permission')
    expect((await server.records.get(id))?.conversation).toBe(1)
    expect(first.approvals).toHaveLength(1)

    const decided = await call(base, `/sessions/${id}/permissions/p-1`, 'POST', { behavior: 'allow' }, generation(1))
    expect(decided.status).toBe(200)
    await until(async () => (await server.records.get(id))?.conversation === 2, 'the queued clear to commit n+1')
    await settled(server, id)
    const next = built[1]!

    const stale = await call(base, `/sessions/${id}/permissions/p-1`, 'POST', { behavior: 'deny' }, generation(1))
    expect({ status: stale.status, error: stale.body.error }).toEqual({ status: 409, error: 'the session moved on to conversation 2' })
    const unknown = await call(base, `/sessions/${id}/permissions/p-1`, 'POST', { behavior: 'deny' }, generation(2))
    expect({ status: unknown.status, error: unknown.body.error }).toEqual({ status: 404, error: 'permission request not found (already resolved or expired)' })
    expect(first.calls.filter((entry) => entry.startsWith('permission'))).toEqual(['permission:p-1'])
    expect(next.approvals).toEqual([])
  })

  it('never hands a decision from an n socket to the runner of n+1', async () => {
    const dir = await fixture.stateDir()
    const { store, reached, release } = holdingStore(dir, (record) => record.cut?.phase === 'committed' && record.cut.from > 0)
    const { server, base, wsBase, built } = await gateway(dir, { store })
    const id = await create(base)
    await settled(server, id)
    const old = await attach(wsBase, id)
    const pending = cut(base, id, 1)
    await reached
    old.send({ generation: 1, type: 'permission_decision', requestId: 'p-9', behavior: 'allow' })
    expect(await old.frames.waitFor((frame) => frame.type === 'protocol_error')).toMatchObject({ message: CUT_IN_PROGRESS })
    release()
    expect((await pending).status).toBe(200)
    await settled(server, id)
    expect(built.flatMap((runner) => runner.calls).filter((entry) => entry.startsWith('permission'))).toEqual([])
  })
})

describe('prompt acks are keyed by conversation', () => {
  it('answers a stale resend from the outcome retained in n and never runs it in n+1', async () => {
    const dir = await fixture.stateDir()
    const { store, reached, release } = holdingStore(dir, (record) => record.cut?.phase === 'prepared' && record.cut.from > 0)
    const { server, base, wsBase, built } = await gateway(dir, { store })
    const id = await create(base)
    await settled(server, id)
    const old = await attach(wsBase, id)
    old.send({ generation: 1, type: 'user_message', text: 'ran', clientId: 'a-1' })
    old.send({ generation: 1, type: 'user_message', text: 'ran', clientId: 'a-1' })
    await eventually(() => expect(old.frames.frames.filter((frame) => frame.type === 'ack' && frame.clientId === 'a-1')).toHaveLength(2))
    const pending = cut(base, id, 1)
    await reached
    old.send({ generation: 1, type: 'user_message', text: 'gated', clientId: 'a-2' })
    expect(await ackOf(old.frames, 'a-2')).toEqual({ type: 'ack', clientId: 'a-2', notDelivered: true })
    release()
    expect((await pending).status).toBe(200)
    await settled(server, id)
    expect(built[0]!.sent).toEqual(['work', 'ran'])

    const next = await attach(wsBase, id)
    const resend = async (clientId: string, text: string, n: number) => {
      next.send({ generation: n, type: 'user_message', text, clientId })
      return await ackOf(next.frames, clientId)
    }
    expect(await resend('a-1', 'ran', 1)).toEqual({ type: 'ack', clientId: 'a-1' })
    expect(await resend('a-2', 'gated', 1)).toEqual({ type: 'ack', clientId: 'a-2', notDelivered: true })
    expect(await resend('a-3', 'never seen', 1)).toEqual({ type: 'ack', clientId: 'a-3', uncertain: true })
    expect(built[1]!.sent).toEqual([])

    // The same client id under n+1 is a new prompt there: its key is `${id}:2`, apart from n's.
    expect(await resend('a-1', 'fresh', 2)).toEqual({ type: 'ack', clientId: 'a-1' })
    next.send({ generation: 2, type: 'user_message', text: 'fresh', clientId: 'a-1' })
    await eventually(() => expect(next.frames.frames.filter((frame) => frame.type === 'ack' && frame.clientId === 'a-1')).toHaveLength(3))
    expect(built[1]!.sent).toEqual(['fresh'])
    expect(await resend('a-1', 'ran', 1)).toEqual({ type: 'ack', clientId: 'a-1' })
    expect(built[1]!.sent).toEqual(['fresh'])
    next.ws.close()
  })
})

describe("a typed /clear is acked with its cut's outcome", () => {
  it('acks a /clear on its own socket before the announce closes it, and never cuts twice for a resend', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await settled(server, id)
    const old = await attach(wsBase, id)
    old.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'c-1' })
    expect(await old.closed).toBe(CONVERSATION_ENDED_CLOSE_CODE)
    const told = old.frames.frames.filter((frame) => frame.type === 'ack' || (frame.type as string) === 'conversation_started')
    expect(told).toEqual([{ type: 'ack', clientId: 'c-1' }, expect.objectContaining({ type: 'conversation_started', conversation: 2 })])
    await settled(server, id)
    const next = await attach(wsBase, id)
    next.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'c-1' })
    expect(await ackOf(next.frames, 'c-1')).toEqual({ type: 'ack', clientId: 'c-1' })
    await drained(next, 'c-probe', 2)
    expect((await server.records.get(id))?.conversation).toBe(2)
    expect(built).toHaveLength(2)
    next.ws.close()
  })

  it('holds the ack of a /clear queued behind a turn until its cut has run', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await settled(server, id)
    const socket = await attach(wsBase, id)
    built[0]!.busy()
    socket.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'q-1' })
    socket.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'q-1' })
    await drained(socket, 'q-probe')
    expect(server.cuts.queued(id)).toBe(true)
    expect(socket.frames.frames.filter((frame) => frame.type === 'ack' && frame.clientId === 'q-1')).toEqual([])
    built[0]!.settle()
    expect(await socket.closed).toBe(CONVERSATION_ENDED_CLOSE_CODE)
    const told = socket.frames.frames.filter(
      (frame) => (frame.type === 'ack' && frame.clientId === 'q-1') || (frame.type as string) === 'conversation_started',
    )
    expect(told).toEqual([{ type: 'ack', clientId: 'q-1' }, expect.objectContaining({ type: 'conversation_started', conversation: 2 })])
    expect(built).toHaveLength(2)
  })

  it('acks a /clear whose cut was refused, now or once queued, as not delivered', async () => {
    const dir = await fixture.stateDir()
    const diagnostics: unknown[] = []
    const { server, base, wsBase, built } = await gateway(dir, { options: { onDiagnostic: (error) => diagnostics.push(error) } })
    const id = await create(base)
    await settled(server, id)
    const socket = await attach(wsBase, id)
    await uncertain(server, id)
    socket.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'r-1' })
    expect(await ackOf(socket.frames, 'r-1')).toEqual({ type: 'ack', clientId: 'r-1', notDelivered: true })
    await call(base, `/sessions/${id}/conversations/pending`, 'POST', { expectedGeneration: 1, send: false })

    built[0]!.busy()
    socket.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'r-2' })
    await until(() => server.cuts.queued(id), 'the /clear to queue behind the turn')
    await uncertain(server, id)
    built[0]!.settle()
    expect(await ackOf(socket.frames, 'r-2')).toEqual({ type: 'ack', clientId: 'r-2', notDelivered: true })
    expect(diagnostics.map(String).join()).toContain('dropped')
    expect((await server.records.get(id))?.conversation).toBe(1)
    expect(socket.ws.readyState).toBe(WebSocket.OPEN)
    socket.ws.close()
  })

  it('answers a resend whose outcome a restart lost as uncertain once the session moved on, and runs it once if it never did', async () => {
    const dir = await fixture.stateDir()
    const restart = async (current: Awaited<ReturnType<typeof gateway>>) => {
      await current.server.parking.flush()
      await current.server.close()
      fixture.servers.splice(fixture.servers.indexOf(current.server), 1)
      return await gateway(dir)
    }
    const first = await gateway(dir)
    const moved = await create(first.base)
    const kept = await create(first.base)
    await settled(first.server, moved)
    await settled(first.server, kept)
    const left = await attach(first.wsBase, moved)
    first.built[0]!.busy()
    left.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'x-1' })
    await until(() => first.server.cuts.queued(moved), 'the /clear to queue behind the turn')
    left.ws.close()
    await left.closed
    first.built[0]!.settle()
    await until(async () => (await first.server.records.get(moved))?.conversation === 2, 'the queued /clear to commit n+1')
    await settled(first.server, moved)
    const lost = await attach(first.wsBase, kept)
    first.built[1]!.busy()
    lost.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'y-1' })
    await until(() => first.server.cuts.queued(kept), 'the /clear to queue behind the turn')
    lost.ws.close()
    await lost.closed

    const second = await restart(first)
    const afterMove = await attach(second.wsBase, moved)
    afterMove.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'x-1' })
    expect(await ackOf(afterMove.frames, 'x-1')).toEqual({ type: 'ack', clientId: 'x-1', uncertain: true })
    expect((await second.server.records.get(moved))?.conversation).toBe(2)
    afterMove.ws.close()

    const unmoved = await attach(second.wsBase, kept)
    unmoved.send({ generation: 1, type: 'user_message', text: '/clear', clientId: 'y-1' })
    expect(await ackOf(unmoved.frames, 'y-1')).toEqual({ type: 'ack', clientId: 'y-1' })
    expect((await second.server.records.get(kept))?.conversation).toBe(2)
  })
})

// Seeds what recovery leaves after a crash while a prompt was being sent: its delivery is unknown.
async function uncertain(server: WorkerServer, id: string): Promise<void> {
  await server.records.transactDurable(id, (current) => ({
    ...current!,
    pendingPrompt: { text: 'lost', n: current!.conversation, state: 'uncertain' },
  }))
}

describe('an uncertain prompt holds every cut door', () => {
  it('refuses REST, discard, restart, typed /clear, clear_context and context_reset with its own code, and keeps the prompt', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await settled(server, id)
    await uncertain(server, id)
    const expected = {
      code: UNCERTAIN_PROMPT_CODE,
      conversation: 1,
      promptConversation: 1,
      error: expect.stringContaining('Send again or Dismiss'),
    }

    expect(await cut(base, id, 1)).toMatchObject({ status: 409, body: expected })
    const discard = await call(base, `/sessions/${id}/conversations/discard`, 'POST', { expectedGeneration: 1, inputRevision: 'any' })
    expect(discard).toMatchObject({ status: 409, body: expected })
    const socket = await attach(wsBase, id)
    socket.send({ generation: 1, type: 'clear_context' })
    expect(await socket.frames.waitFor((frame) => frame.type === 'protocol_error')).toMatchObject({
      message: expect.stringContaining('Send again'),
    })
    socket.send({ generation: 1, type: 'user_message', text: '/clear' })
    await eventually(() => expect(socket.frames.frames.filter((frame) => frame.type === 'protocol_error')).toHaveLength(2))
    await expect(server.cuts.clearOnIdle(built[0]!, 'context_reset', 'next')).rejects.toMatchObject({ code: UNCERTAIN_PROMPT_CODE })
    built[0]!.busy()
    await expect(server.cuts.clearOnIdle(built[0]!, 'context_reset')).rejects.toMatchObject({ code: UNCERTAIN_PROMPT_CODE })
    built[0]!.settle()
    expect(server.cuts.queued(id)).toBe(false)

    const record = await server.records.get(id)
    expect(record).toMatchObject({ conversation: 1, pendingPrompt: { text: 'lost', state: 'uncertain' } })
    expect(built).toHaveLength(1)
    expect(built[0]!.sent).toEqual(['work'])

    expect((await call(base, `/sessions/${id}/conversations/pending`, 'POST', { expectedGeneration: 1, send: false })).status).toBe(200)
    expect((await cut(base, id, 1)).status).toBe(200)
    socket.ws.close()
  })

  it('refuses a new conversation of a named session the same way', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const created = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-a', prompt: 'work', agent: { name: 'Named' } })
    expect(created.status).toBe(201)
    const id = created.body.session.id as string
    await settled(server, id)
    await uncertain(server, id)
    expect(await cut(base, id, 1)).toMatchObject({ status: 409, body: { code: UNCERTAIN_PROMPT_CODE } })
    expect((await server.records.get(id))?.pendingPrompt).toMatchObject({ text: 'lost', state: 'uncertain' })
  })

  it('drops a context_reset queued before the prompt became uncertain, with a diagnostic', async () => {
    const dir = await fixture.stateDir()
    const diagnostics: unknown[] = []
    const { server, base, built } = await gateway(dir, { options: { onDiagnostic: (error) => diagnostics.push(error) } })
    const id = await create(base)
    await settled(server, id)
    built[0]!.busy()
    expect(await server.cuts.clearOnIdle(built[0]!, 'context_reset', 'next')).toBeUndefined()
    await uncertain(server, id)
    built[0]!.settle()
    await eventually(() => expect(diagnostics.map(String).join()).toContain('context_reset for'))
    expect(diagnostics.map(String).join()).toContain('Send again or Dismiss')
    expect(await server.records.get(id)).toMatchObject({ conversation: 1, pendingPrompt: { text: 'lost', state: 'uncertain' } })
    expect(built).toHaveLength(1)
  })
})

describe('a door that asked n while another door cut', () => {
  it('refuses the stale request instead of queueing it on n, so a later clear of n+1 still cuts', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base)
    await settled(server, id)
    built[0]!.busy()
    const paused = deferred()
    const get = server.records.get.bind(server.records)
    const spy = vi.spyOn(server.records, 'get').mockImplementationOnce(async (key) => {
      await paused.promise
      return await get(key)
    })
    const stale = server.cuts.clearOnIdle(built[0]!, 'context_reset')
    built[0]!.settle()
    expect((await cut(base, id, 1)).status).toBe(200)
    await settled(server, id)
    paused.resolve()
    await expect(stale).rejects.toMatchObject({ status: 409 })
    spy.mockRestore()

    const next = built.at(-1)!
    next.busy()
    expect(await server.cuts.clearOnIdle(next, 'context_reset')).toBeUndefined()
    next.settle()
    await eventually(async () => expect((await server.records.get(id))?.conversation).toBe(3))
  })
})

describe('execution results across the cut', () => {
  function dispatch(runner: Engine, executionId: string): void {
    runner.emit({ type: 'execution_dispatched', executionId, toolName: 'tool', backend: 'server', deferred: true })
    runner.emit({ type: 'execution_failed', executionId, reason: 'timeout', error: 'late' })
  }

  it('refuses a result while the cut is under way, then refuses it for the ended conversation with its own error', async () => {
    const dir = await fixture.stateDir()
    const { store, reached, release } = holdingStore(dir, (record) => record.cut?.phase === 'committed' && record.cut.from > 0)
    const { server, base, built } = await gateway(dir, { store })
    const id = await create(base)
    await settled(server, id)
    built[0]!.emit({ type: 'execution_dispatched', executionId: 'x-1', toolName: 'tool', backend: 'server', deferred: true })
    const pending = cut(base, id, 1)
    await reached
    const during = await call(base, '/executions/x-1/result', 'POST', { status: 'ok', output: { value: 1 } })
    expect(during).toMatchObject({ status: 409, body: { error: CUT_IN_PROGRESS } })
    release()
    expect((await pending).status).toBe(200)
    await settled(server, id)
    const late = await call(base, '/executions/x-1/result', 'POST', { status: 'failed', reason: 'timeout', error: 'late' })
    expect(late).toMatchObject({ status: 409, body: { error: 'execution belongs to conversation 1, which has ended' } })
    const unknown = await call(base, '/executions/x-unknown/result', 'POST', { status: 'ok', output: { value: 1 } })
    expect(unknown.status).toBe(404)
    expect(built[1]!.calls).toEqual([])
  })

  it('answers a scoped caller who could see the ended conversation with 409, and anyone else with 404', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir, { scoped: true })
    const id = await create(base, {}, 'tenant-a')
    await settled(server, id)
    dispatch(built[0]!, 'x-2')
    expect((await cut(base, id, 1, 'tenant-a')).status).toBe(200)
    await settled(server, id)
    const result = { status: 'ok', output: { value: 1 } }
    const owner = await call(base, '/executions/x-2/result', 'POST', result, bearer('tenant-a'))
    expect(owner).toMatchObject({ status: 409, body: { error: expect.stringContaining('conversation 1') } })
    const operator = await call(base, '/executions/x-2/result', 'POST', result, bearer('operator'))
    expect(operator.status).toBe(409)
    const stranger = await call(base, '/executions/x-2/result', 'POST', result, bearer('tenant-b'))
    expect(stranger).toMatchObject({ status: 404, body: { error: 'execution not found' } })
  })
})

describe('peer messages at the cut', () => {
  it('never carries a peer message queued at n into n+1: the cut refuses it, and only a confirmed discard drops it', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const sender = await create(base)
    const target = await create(base)
    await settled(server, target)
    const peers = built[0]!.config.peers!
    const first = built[1]!
    first.answering = false
    first.busy()
    expect(await peers.send(sender, target, 'queued for n')).toMatchObject({ delivered: true, queued: true })
    first.settle()

    const refused = await cut(base, target, 1)
    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'unconfirmed_input', conversation: 1, pendingInput: 1, mayIncludePeer: true },
    })
    const discarded = await call(base, `/sessions/${target}/conversations/discard`, 'POST', {
      expectedGeneration: 1,
      inputRevision: refused.body.inputRevision,
    })
    expect(discarded).toMatchObject({ status: 200, body: { conversation: 2 } })
    await settled(server, target)
    const next = built.at(-1)!
    expect(next).not.toBe(first)
    expect(next.sent).toEqual([])
    expect(first.sent).toEqual(['work', 'queued for n'])

    expect(await peers.send(sender, target, 'for the latest')).toMatchObject({ delivered: true, sessionId: target })
    expect(next.sent).toEqual(['for the latest'])
  })

  it('keeps a queued clear waiting while a peer message is unanswered, rather than cutting past it', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const sender = await create(base)
    const target = await create(base)
    await settled(server, target)
    const peers = built[0]!.config.peers!
    const first = built[1]!
    const socket = await attach(wsBase, target)
    first.busy()
    socket.send({ generation: 1, type: 'clear_context' })
    await until(() => server.cuts.queued(target), 'the clear to queue behind the turn')
    first.answering = false
    expect(await peers.send(sender, target, 'arrived while busy')).toMatchObject({ delivered: true, queued: true })
    first.settle()
    expect(server.cuts.queued(target)).toBe(true)
    expect((await server.records.get(target))?.conversation).toBe(1)
    expect(server.registry.get(target)).toBe(first)
    expect(built).toHaveLength(2)
    socket.ws.close()
  })

  it.each([0, 1, 3, 8, 16])('never lets a peer wake that raced a cut by %i ticks become n+1', async (ticks) => {
    const dir = await fixture.stateDir()
    const before = await gateway(dir)
    const sender = await create(before.base)
    const target = await create(before.base)
    await settled(before.server, target)
    await before.server.parking.flush()
    await before.server.close()
    fixture.servers.splice(fixture.servers.indexOf(before.server), 1)

    const { server, built } = await gateway(dir)
    const peers = ((await server.parking.ensureLive(sender)) as Engine).config.peers!
    const woken = peers.send(sender, target, 'wake up')
    for (let i = 0; i < ticks; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const moved = server.cuts.cut(target, { expectedGeneration: 1, reason: 'user' }).catch((error: unknown) => error)
    const [delivery, result] = await Promise.all([woken, moved])
    await eventually(() => expect(server.registry.get(target)?.info().status).toBe('idle'))
    const live = server.registry.get(target) as Engine
    const record = await server.records.get(target)
    const others = built.filter((runner) => runner !== live && runner.id === target)
    expect(others.every((runner) => runner.info().status === 'closed')).toBe(true)
    if (result instanceof Error) {
      expect(result.message).toBe(WOKE_DURING_CUT)
      expect(record).toMatchObject({ conversation: 1 })
      expect(record?.cut).toBeUndefined()
      expect(live.config.resume).toBe(`engine-${target}`)
      expect(delivery).toMatchObject({ delivered: true })
      expect(live.sent).toEqual(['wake up'])
      return
    }
    expect(result).toMatchObject({ conversation: 2 })
    expect(record).toMatchObject({ conversation: 2 })
    expect(record?.startFailed).toBeUndefined()
    expect(live.config.resume).toBeUndefined()
    expect(live.sent).toEqual([])
    expect(others.flatMap((runner) => runner.sent).length).toBeLessThanOrEqual(1)
  })
})

describe('the cut stops its runner quietly', () => {
  async function receiver() {
    const received: SessionNotification[] = []
    const hook: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as SessionNotification)
        res.writeHead(200).end()
      })
    })
    const port = await new Promise<number>((resolve) => {
      hook.listen(0, '127.0.0.1', () => {
        const address = hook.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    return { received, url: `http://127.0.0.1:${port}/hook`, close: () => new Promise<void>((resolve) => hook.close(() => resolve())) }
  }

  it('fires no session_closed webhook or push for a cut from any door, and one of each for a real DELETE', async () => {
    const hook = await receiver()
    try {
      const pushed: SessionNotification[] = []
      const dir = await fixture.stateDir()
      const { server, base, wsBase } = await gateway(dir, {
        options: { notifications: { webhook: { url: hook.url, events: ['session_closed'] }, onNotification: (note) => pushed.push(note) } },
      })
      const id = await create(base)
      await settled(server, id)
      expect((await cut(base, id, 1)).status).toBe(200)
      await settled(server, id)
      const socket = await attach(wsBase, id)
      socket.send({ generation: 2, type: 'user_message', text: '/clear' })
      await until(async () => (await server.records.get(id))?.conversation === 3, 'the typed /clear to commit')
      await settled(server, id)
      const again = await attach(wsBase, id)
      again.send({ generation: 3, type: 'clear_context' })
      await until(async () => (await server.records.get(id))?.conversation === 4, 'the clear_context to commit')
      await settled(server, id)
      expect(pushed.filter((note) => note.type === 'session_closed')).toEqual([])

      // Webhooks for one id are delivered in order, so the DELETE's arriving first proves no cut posted one.
      expect((await call(base, `/sessions/${id}`, 'DELETE', undefined, generation(4))).status).toBe(200)
      await until(() => hook.received.length > 0, 'the DELETE webhook')
      expect(hook.received).toEqual([expect.objectContaining({ type: 'session_closed', session: expect.objectContaining({ id }) })])
      expect(pushed.filter((note) => note.type === 'session_closed')).toHaveLength(1)
    } finally {
      await hook.close()
    }
  })
})
