import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EngineAdapter, SessionRunnerConfig } from '@workerdeck/core'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  CONVERSATION_ENDED_CLOSE_CODE,
  ENGINE_CAPABILITIES,
  type ProfileEngine,
  type ProfileInfo,
  type SessionInfo,
  type SessionNotification,
} from '@workerdeck/protocol'
import {
  createFileSessionRecordStore,
  createWorkerServer,
  StaleConversationError,
  type SessionRecordStore,
  type WorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import type { ConversationCuts } from '../src/services/conversation-cuts.ts'
import type { DormantSessionRecord } from '../src/services/session-store.ts'
import { EngineRunner } from './engine-runner.ts'
import { fakeHarness, frameCollector, gatewayFixture } from './helpers.ts'

const PROFILES: ProfileInfo[] = [
  { name: 'engine', engine: 'provider', provider: { id: 'test', model: 'test-model' } },
  { name: 'claude-a', engine: 'claude', configDir: '/tmp/wd-cut-claude-a' },
  { name: 'codex-b', engine: 'codex', codexHome: '/tmp/wd-cut-codex-b' },
]

const PRINCIPALS: Record<string, unknown> = {
  'tenant-a': { scope: { tenant: 'a' }, allowedProfiles: ['claude-a'] },
  'tenant-b': { scope: { tenant: 'b' }, allowedProfiles: ['claude-a'] },
}

const fixture = gatewayFixture('wd-cut-')
beforeAll(() => {
  mkdirSync('/tmp/wd-cut-claude-a', { recursive: true })
  mkdirSync('/tmp/wd-cut-codex-b', { recursive: true })
})
afterEach(fixture.cleanup)

class Engine extends EngineRunner {
  constructor(
    id: string,
    config: SessionRunnerConfig,
    readonly engine: ProfileEngine,
  ) {
    super(id, config)
  }

  override info(): SessionInfo {
    const info = super.info()
    return {
      ...info,
      engine: this.engine,
      capabilities: { ...ENGINE_CAPABILITIES[this.engine], resume: true, resumeBackfill: true },
      ...(this.config.scope ? { scope: this.config.scope } : {}),
      ...(this.config.meta ? { meta: this.config.meta } : {}),
    }
  }
}

type Hooks = { building?: (runner: Engine) => void; options?: Partial<WorkerServerOptions>; scoped?: boolean; store?: SessionRecordStore }

async function gateway(dir: string, hooks: Hooks = {}) {
  const built: Engine[] = []
  let n = 0
  const make = (engine: ProfileEngine, config: SessionRunnerConfig, id: string | undefined): Engine => {
    const runner = new Engine(id ?? `s${++n}-${dir.slice(-6)}`, config, engine)
    built.push(runner)
    hooks.building?.(runner)
    return runner
  }
  const adapter = (engine: ProfileEngine): EngineAdapter => ({
    engine,
    capabilities: ENGINE_CAPABILITIES[engine],
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => make(engine, config, id),
  })
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
    engines: { claude: adapter('claude'), codex: adapter('codex') },
    sessions: { store: hooks.store ?? createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
    parking: { parkDelayMs: 10 },
    historyReader: {
      read: async (target) => ({ kind: 'ok', events: [{ type: 'user_message', text: `from ${target.engineSessionId}` }] as never }),
    },
    createEngineRunner: async ({ config, id }) => make('provider', config, id),
    ...hooks.options,
  })
  fixture.servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, built, base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

async function call(base: string, path: string, method = 'GET', body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function create(base: string, extra: Record<string, unknown> = {}, token?: string): Promise<string> {
  const res = await call(base, '/sessions', 'POST', { cwd: '/tmp/project', profile: 'claude-a', prompt: 'work', ...extra }, token)
  expect(res.status).toBe(201)
  return (res.body.session as SessionInfo).id
}

async function idle(server: WorkerServer, id: string): Promise<void> {
  await vi.waitFor(() => expect(server.registry.get(id)?.info().status).toBe('idle'))
}

async function stop(server: WorkerServer): Promise<void> {
  await server.parking.flush()
  await server.close()
  fixture.servers.splice(fixture.servers.indexOf(server), 1)
}

function cutsOf(server: WorkerServer): ConversationCuts {
  return server.cuts
}

describe('conversation cut under a stable id', () => {
  it('keeps the id, bumps conversation and epoch, starts a fresh engine conversation, and sends the prompt once', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    const before = server.registry.get(id)!.info()

    const res = await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1, prompt: 'next' })
    expect(res.status).toBe(200)
    expect(res.body.conversation).toBe(2)
    expect(res.body.session.id).toBe(id)
    const fresh = built.at(-1)!
    expect(fresh).not.toBe(built[0])
    expect(fresh.config.resume).toBeUndefined()
    expect(fresh.config.forkSession).toBeUndefined()
    expect(fresh.config.epoch).toBe((before.epoch ?? 0) + 1)
    expect(fresh.config.engineHome).toEqual({ claudeConfigDir: '/tmp/wd-cut-claude-a' })
    await idle(server, id)
    expect(fresh.sent).toEqual(['next'])
    expect(built[0]!.info().status).toBe('closed')

    const list = await call(base, `/sessions/${id}/conversations`)
    expect(list.body).toMatchObject({ conversation: 2, history: [{ n: 1, engine: 'claude', engineSessionId: before.sdkSessionId }] })
    expect(list.body.pendingPrompt).toBeUndefined()
    const stored = await server.parking.get(id)
    expect(stored).toMatchObject({ kind: 'dormant', sdkSessionId: `engine-${id}` })
    const old = await call(base, `/sessions/${id}/conversations/1`)
    expect(old.body.events).toEqual([expect.objectContaining({ type: 'user_message', text: `from ${before.sdkSessionId}` })])
  })

  it('refuses a stale generation, a busy session and a job run, and changes nothing', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 2 })).status).toBe(409)
    built[0]!.busy()
    const busy = await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    expect(busy.status).toBe(409)
    expect(busy.body.error).toContain('busy')
    const job = await create(base, { meta: { jobId: 'j1' } })
    await idle(server, job)
    expect((await call(base, `/sessions/${job}/conversations`, 'POST', { expectedGeneration: 1 })).body.error).toContain('job')
    expect(built).toHaveLength(2)
    expect((await call(base, `/sessions/${id}/conversations`)).body).toMatchObject({ conversation: 1, history: [] })
  })

  it('rolls a refused commit write back: same n, and the old engine conversation resumes on the next wake', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    cutsOf(server).faults.add('commit')
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(500)
    cutsOf(server).faults.clear()
    expect((await call(base, `/sessions/${id}/conversations`)).body).toMatchObject({ conversation: 1, history: [] })
    await server.parking.ensureLive(id)
    expect(built.at(-1)!.config.resume).toBe(`engine-${id}`)
  })

  it('recovers a crash after the stop by rolling back to the same conversation', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    cutsOf(first.server).faults.add('after-stop')
    expect((await call(first.base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })).status).toBe(500)
    await stop(first.server)

    const second = await gateway(dir)
    expect((await call(second.base, `/sessions/${id}/conversations`)).body).toMatchObject({ conversation: 1, history: [] })
    await second.server.parking.ensureLive(id)
    expect(second.built.at(-1)!.config.resume).toBe(`engine-${id}`)
  })

  it('recovers a crash after the commit by starting n+1 exactly once and sending the prompt once', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    cutsOf(first.server).faults.add('after-commit')
    expect((await call(first.base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1, prompt: 'next' })).status).toBe(500)
    await stop(first.server)

    const second = await gateway(dir)
    expect(second.built).toHaveLength(1)
    const fresh = second.built[0]!
    expect(fresh.config.resume).toBeUndefined()
    await vi.waitFor(() => expect(fresh.sent).toEqual(['next']))
    expect((await call(second.base, `/sessions/${id}/conversations`)).body).toMatchObject({ conversation: 2, history: [{ n: 1 }] })
    await stop(second.server)
    const third = await gateway(dir)
    await third.server.parking.ensureLive(id)
    expect(third.built.at(-1)!.config.resume).toBe(`engine-${id}`)
    expect(third.built.at(-1)!.sent).toEqual([])
  })

  it('records a failed start durably, refuses a second cut, and retries the same n', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    cutsOf(server).faults.add('start')
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 2 })).status).toBe(409)
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1, prompt: 'p' })).status).toBe(502)
    expect((await call(base, `/sessions/${id}/conversations`)).body).toMatchObject({ conversation: 2, startFailed: { n: 2 } })
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 2 })).status).toBe(409)
    cutsOf(server).faults.clear()
    const retried = await call(base, `/sessions/${id}/conversations/retry`, 'POST', {})
    expect(retried.body.conversation).toBe(2)
    await vi.waitFor(() => expect(built.at(-1)!.sent).toEqual(['p']))
  })

  it('binds a socket to its conversation: announced and closed at the cut, a stale generation refused after', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const frames = frameCollector(ws)
    await frames.waitFor((frame) => frame.type === 'attached')
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))

    await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    const started = (await frames.waitFor((frame) => (frame.type as string) === 'conversation_started')) as unknown as Record<
      string,
      number
    >
    expect(started).toMatchObject({ conversation: 2 })
    expect(await closed).toBe(CONVERSATION_ENDED_CLOSE_CODE)
    expect(frames.frames.some((frame) => frame.type === 'event' && frame.event.type === 'session_closed')).toBe(false)

    const again = new WebSocket(`${wsBase}/sessions/${id}/ws?afterSeq=99`)
    const next = frameCollector(again)
    const attached = (await next.waitFor((frame) => frame.type === 'attached')) as Extract<
      (typeof frames.frames)[number],
      { type: 'attached' }
    >
    expect(attached.session.epoch).toBe(started.epoch)
    again.send(JSON.stringify({ type: 'user_message', text: 'late', generation: 1 }))
    const refused = await next.waitFor((frame) => frame.type === 'protocol_error')
    expect(refused).toMatchObject({ message: expect.stringContaining('ended') })
    expect(built.at(-1)!.sent).toEqual([])
    again.close()

    const permission = await fetch(`${base}/sessions/${id}/sleep`, { method: 'POST', headers: { 'x-workerdeck-generation': '1' } })
    expect(permission.status).toBe(409)
  })

  it('turns a typed /clear and a clear_context frame into a cut, queued while busy', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const frames = frameCollector(ws)
    await frames.waitFor((frame) => frame.type === 'attached')
    ws.send(JSON.stringify({ type: 'user_message', text: ' /clear ' }))
    await vi.waitFor(async () => expect((await call(base, `/sessions/${id}/conversations`)).body.conversation).toBe(2))
    expect(built[0]!.sent).not.toContain(' /clear ')
    await idle(server, id)

    const ws2 = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const frames2 = frameCollector(ws2)
    await frames2.waitFor((frame) => frame.type === 'attached')
    built.at(-1)!.busy()
    ws2.send(JSON.stringify({ type: 'clear_context' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await call(base, `/sessions/${id}/conversations`)).body.conversation).toBe(2)
    built.at(-1)!.settle()
    await vi.waitFor(async () => expect((await call(base, `/sessions/${id}/conversations`)).body.conversation).toBe(3))
  })

  it('refuses a late execution result for an ended conversation with its own error', async () => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    built[0]!.emit({ type: 'execution_dispatched', executionId: 'x1', toolName: 'tool', backend: 'server', deferred: true })
    built[0]!.emit({ type: 'execution_failed', executionId: 'x1', reason: 'timeout', error: 'late' })
    await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    const late = await call(base, '/executions/x1/result', 'POST', { status: 'ok', output: { value: 1 } })
    expect(late.status).toBe(409)
    expect(late.body.error).toContain('conversation 1')
  })

  it('authorizes history by its frozen projection across a scope change', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir, { scoped: true })
    const id = await create(base, { profile: 'claude-a' }, 'tenant-a')
    await idle(server, id)
    const moved = await call(
      base,
      `/sessions/${id}/conversations`,
      'POST',
      { expectedGeneration: 1, target: { scope: { tenant: 'b' } } },
      'operator',
    )
    expect(moved.status).toBe(200)
    await idle(server, id)

    expect((await call(base, `/sessions/${id}`, 'GET', undefined, 'tenant-a')).status).toBe(404)
    const forA = await call(base, `/sessions/${id}/conversations`, 'GET', undefined, 'tenant-a')
    expect(forA.body).toEqual({ history: [expect.objectContaining({ n: 1 })] })
    expect((await call(base, `/sessions/${id}/conversations/1`, 'GET', undefined, 'tenant-a')).status).toBe(200)

    const forB = await call(base, `/sessions/${id}/conversations`, 'GET', undefined, 'tenant-b')
    expect(forB.body).toEqual({ conversation: 2, history: [] })
    expect((await call(base, `/sessions/${id}/conversations/1`, 'GET', undefined, 'tenant-b')).status).toBe(404)
    const scoped = await call(
      base,
      `/sessions/${id}/conversations`,
      'POST',
      { expectedGeneration: 2, target: { scope: { tenant: 'a' } } },
      'tenant-b',
    )
    expect(scoped.status).toBe(403)
  })

  it.each([
    ['claude-a', 'codex-b', { codexHome: '/tmp/wd-cut-codex-b' }],
    ['codex-b', 'claude-a', { claudeConfigDir: '/tmp/wd-cut-claude-a' }],
    ['claude-a', 'engine', undefined],
  ])('switches %s -> %s with each conversation pinned to its own engine home', async (from, to, home) => {
    const dir = await fixture.stateDir()
    const { server, base, built } = await gateway(dir)
    const id = await create(base, { profile: from })
    await idle(server, id)
    const res = await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1, target: { profile: to } })
    expect(res.status).toBe(200)
    const fresh = built.at(-1)!
    expect(fresh.info().engine).toBe(PROFILES.find((profile) => profile.name === to)!.engine)
    expect(fresh.config.engineHome).toEqual(home)
    expect(fresh.config.resume).toBeUndefined()
    const [entry] = (await call(base, `/sessions/${id}/conversations`)).body.history
    expect(entry).toMatchObject({ n: 1, profile: from, engine: PROFILES.find((profile) => profile.name === from)!.engine })
    expect(entry.engineHome).toBeUndefined()
    expect((await server.records.get(id))?.conversations[0]?.engineHome).toEqual(
      from === 'claude-a' ? { claudeConfigDir: '/tmp/wd-cut-claude-a' } : { codexHome: '/tmp/wd-cut-codex-b' },
    )
  })

  it('keeps history readable on a closed unnamed session, current conversation included', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    await idle(server, id)
    expect((await call(base, `/sessions/${id}`, 'DELETE')).status).toBe(200)
    expect((await call(base, `/sessions/${id}`)).status).toBe(404)
    const list = await call(base, `/sessions/${id}/conversations`)
    expect(list.body).toEqual({ history: [expect.objectContaining({ n: 1 }), expect.objectContaining({ n: 2 })] })
    expect((await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 2 })).status).toBe(404)
  })
})

describe('conversation cut on the one session record', () => {
  it('refuses a parking write queued behind the commit: the record keeps n+1 and no stale engine id', async () => {
    const dir = await fixture.stateDir()
    const inner = createFileSessionRecordStore({ dir: join(dir, 'sessions') })
    let release: (() => void) | undefined
    let committing: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      committing = resolve
    })
    const store: SessionRecordStore = {
      ...inner,
      save: async (record) => {
        if (record.cut?.phase === 'committed' && release === undefined) {
          committing!()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        await inner.save(record)
      },
    }
    const { server, base } = await gateway(dir, { store })
    const id = await create(base)
    await idle(server, id)
    const stale = (await server.parking.get(id)) as DormantSessionRecord
    expect(stale.info.conversation).toBe(1)

    const cut = call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    await reached
    const write = server.records.runtimeStore().save({ ...stale, sdkSessionId: 'stale-engine' })
    const clear = server.records.runtimeStore().delete(id, 1)
    release!()
    await expect(write).rejects.toBeInstanceOf(StaleConversationError)
    await expect(clear).rejects.toBeInstanceOf(StaleConversationError)
    expect((await cut).status).toBe(200)
    await idle(server, id)
    await server.parking.flush()

    const record = await server.records.get(id)
    expect(record).toMatchObject({ conversation: 2, conversations: [{ n: 1, engineSessionId: `engine-${id}` }] })
    expect(record?.cut).toBeUndefined()
    const runtime = record?.runtime as DormantSessionRecord
    expect(runtime.kind).toBe('dormant')
    expect(runtime.sdkSessionId).not.toBe('stale-engine')
    expect(record?.runtime?.info.conversation).toBe(2)
  })

  it('commits a dormant runtime with no engine id, so a crash before the start wakes into a fresh n+1', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    first.server.cuts.faults.add('after-commit')
    await call(first.base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    const runtime = (await first.server.records.get(id))?.runtime as DormantSessionRecord
    expect(runtime).toMatchObject({ kind: 'dormant', info: { conversation: 2, epoch: 1 } })
    expect(runtime.sdkSessionId).toBeUndefined()
    expect(await first.server.records.runtimeStore().delete(id, 2, 'resumed')).toBe(true)
  })

  it('turns a crash while sending the pending prompt into uncertain, then sends or dismisses it on request', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    await first.server.records.transact(id, (current) => ({ ...current!, pendingPrompt: { text: 'again?', n: 1, state: 'sending' } }))
    await stop(first.server)

    const second = await gateway(dir)
    const listed = await call(second.base, `/sessions/${id}/conversations`)
    expect(listed.body.pendingPrompt).toEqual({ text: 'again?', n: 1, state: 'uncertain' })
    expect(second.built).toHaveLength(0)
    expect((await call(second.base, `/sessions/${id}/conversations/pending`, 'POST', { send: true })).status).toBe(200)
    expect(second.built.at(-1)!.sent).toEqual(['again?'])
    expect((await call(second.base, `/sessions/${id}/conversations`)).body.pendingPrompt).toBeUndefined()

    await second.server.records.transact(id, (current) => ({ ...current!, pendingPrompt: { text: 'drop me', n: 1, state: 'uncertain' } }))
    expect((await call(second.base, `/sessions/${id}/conversations/pending`, 'POST', { send: false })).status).toBe(200)
    expect(second.built.at(-1)!.sent).toEqual(['again?'])
    expect((await call(second.base, `/sessions/${id}/conversations/pending`, 'POST', { send: false })).status).toBe(404)
  })

  it('invalidates permission decisions and prompt acks at the cut', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const frames = frameCollector(ws)
    await frames.waitFor((frame) => frame.type === 'attached')
    ws.send(JSON.stringify({ type: 'user_message', text: 'once', clientId: 'c-1' }))
    await frames.waitFor((frame) => frame.type === 'ack')
    expect(built[0]!.sent).toEqual(['work', 'once'])
    await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    await idle(server, id)

    const stalePermission = await fetch(`${base}/sessions/${id}/permissions/p-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workerdeck-generation': '1' },
      body: JSON.stringify({ behavior: 'allow' }),
    })
    expect(stalePermission.status).toBe(409)
    const again = new WebSocket(`${wsBase}/sessions/${id}/ws`)
    const next = frameCollector(again)
    await next.waitFor((frame) => frame.type === 'attached')
    again.send(JSON.stringify({ type: 'user_message', text: 'once', clientId: 'c-1', generation: 2 }))
    await next.waitFor((frame) => frame.type === 'ack')
    expect(built.at(-1)!.sent).toEqual(['once'])
    again.close()
  })

  it('persists and reads back the record before the session is published, and refuses a create whose record does not hold', async () => {
    const dir = await fixture.stateDir()
    const inner = createFileSessionRecordStore({ dir: join(dir, 'sessions') })
    let lying = false
    const store: SessionRecordStore = { ...inner, get: async (id) => (lying ? null : inner.get(id)) }
    const { server, base, built } = await gateway(dir, { store })
    const id = await create(base)
    const record = await inner.get(id)
    expect(record).toMatchObject({ id, conversation: 1, requested: { cwd: '/tmp/project', profile: 'claude-a' } })
    expect(record?.requested?.prompt).toBeUndefined()

    lying = true
    const refused = await call(base, '/sessions', 'POST', { cwd: '/tmp/project', profile: 'claude-a', prompt: 'work' })
    expect(refused.status).toBe(500)
    expect(built).toHaveLength(2)
    expect(built[1]!.info().status).toBe('closed')
    expect(server.registry.list().map((info) => info.id)).toEqual([id])
  })

  it('refuses a cut on a job run from every door', async () => {
    const dir = await fixture.stateDir()
    const { server, base, wsBase, built } = await gateway(dir)
    const job = await create(base, { meta: { jobId: 'j1' } })
    await idle(server, job)
    const ws = new WebSocket(`${wsBase}/sessions/${job}/ws`)
    const frames = frameCollector(ws)
    await frames.waitFor((frame) => frame.type === 'attached')
    ws.send(JSON.stringify({ type: 'clear_context' }))
    expect(await frames.waitFor((frame) => frame.type === 'protocol_error')).toMatchObject({ message: expect.stringContaining('job') })
    ws.close()
    expect(built).toHaveLength(1)
    expect((await server.records.get(job))?.conversation).toBe(1)
  })

  it('stops the old runner quietly: no session_closed notification for a cut, one for a close', async () => {
    const dir = await fixture.stateDir()
    const notes: SessionNotification[] = []
    const { server, base } = await gateway(dir, { options: { notifications: { onNotification: (note) => notes.push(note) } } })
    const id = await create(base)
    await idle(server, id)
    await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    await idle(server, id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(notes.filter((note) => note.type === 'session_closed')).toEqual([])

    await call(base, `/sessions/${id}`, 'DELETE')
    await vi.waitFor(() => expect(notes.filter((note) => note.type === 'session_closed')).toHaveLength(1))
  })

  it('names the conversation on every session the gateway hands out', async () => {
    const dir = await fixture.stateDir()
    const { server, base } = await gateway(dir)
    const id = await create(base)
    await idle(server, id)
    expect((await call(base, `/sessions/${id}`)).body.session.conversation).toBe(1)
    await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1 })
    expect((await call(base, '/sessions')).body.sessions[0]).toMatchObject({ id, conversation: 2 })
  })
})

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp',
  tools: [],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  uuid: 'u-init',
} as unknown as SDKMessage

const RESULT = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'ok',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: 'u-r',
  session_id: 'sdk-1',
} as unknown as SDKMessage

describe('conversation cut on the real claude runner', () => {
  it('starts the next conversation as a fresh, persisted engine session in the same config dir', async () => {
    const dir = await fixture.stateDir()
    const harnesses: Array<ReturnType<typeof fakeHarness>> = []
    const server = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [{ name: 'claude-a', engine: 'claude', configDir: '/tmp/wd-cut-claude-a' }],
      sessions: { store: createFileSessionRecordStore({ dir: join(dir, 'sessions') }) },
      buildRunnerConfig: (req) => ({
        ...req,
        queryFn: (params) => {
          const harness = fakeHarness()
          harnesses.push(harness)
          return harness.queryFn(params)
        },
      }),
    })
    fixture.servers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const id = await create(base)
    await vi.waitFor(() => expect(harnesses).toHaveLength(1))
    harnesses[0]!.emit(INIT)
    harnesses[0]!.emit(RESULT)
    await idle(server, id)

    const res = await call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration: 1, prompt: 'next' })
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(harnesses).toHaveLength(2))
    const [first, second] = harnesses.map((harness) => harness.captured.options!)
    expect(second!.resume).toBeUndefined()
    expect(second!.forkSession).toBeUndefined()
    expect(second!.persistSession).not.toBe(false)
    expect(first!.persistSession).not.toBe(false)
    expect(second!.env?.CLAUDE_CONFIG_DIR).toBe(first!.env?.CLAUDE_CONFIG_DIR)
    expect(second!.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/wd-cut-claude-a')
    expect((await call(base, `/sessions/${id}/conversations`)).body).toMatchObject({ history: [{ n: 1, engineSessionId: 'sdk-1' }] })
  })
})
