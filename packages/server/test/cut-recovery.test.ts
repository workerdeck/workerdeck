import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import {
  createFileSessionRecordStore,
  createWorkerServer,
  StaleConversationError,
  type SessionRecord,
  type SessionRecordStore,
  type WorkerServer,
  type WorkerServerOptions,
} from '../src/index.ts'
import type { CutFault } from '../src/services/conversation-cuts.ts'
import type { DormantSessionRecord } from '../src/services/session-store.ts'
import { EngineRunner } from './engine-runner.ts'
import { gatewayFixture, listenOn } from './helpers.ts'

let configDir: string
let serial = 0

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wd-recovery-claude-'))
})
afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

const fixture = gatewayFixture('wd-recovery-')
afterEach(fixture.cleanup)

// Every runner names its own engine conversation, so n and n+1 never share an engine pointer; a resume keeps it.
class Engine extends EngineRunner {
  readonly engineName = `sdk-${++serial}`

  override info(): SessionInfo {
    const info = super.info()
    return {
      ...info,
      engine: 'claude',
      capabilities: { ...ENGINE_CAPABILITIES.claude, resume: true, resumeBackfill: true },
      ...(info.sdkSessionId === undefined ? {} : { sdkSessionId: this.config.resume ?? this.engineName }),
    }
  }
}

type Hooks = {
  building?: (runner: Engine) => void
  options?: Partial<WorkerServerOptions>
  store?: (inner: SessionRecordStore) => SessionRecordStore
}

type Diagnostic = { error: unknown; where: string }

function build(dir: string, hooks: Hooks = {}) {
  const built: Engine[] = []
  const diagnostics: Diagnostic[] = []
  const storeErrors: unknown[] = []
  const inner = createFileSessionRecordStore({ dir: join(dir, 'sessions'), onError: (error) => storeErrors.push(error) })
  const adapter: EngineAdapter = {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => {
      const runner = new Engine(id ?? `s${built.length + 1}-${dir.slice(-6)}`, config)
      built.push(runner)
      hooks.building?.(runner)
      return runner
    },
  }
  const server: WorkerServer = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [{ name: 'claude-r', engine: 'claude', configDir }],
    engines: { claude: adapter },
    sessions: { store: hooks.store ? hooks.store(inner) : inner },
    parking: { parkDelayMs: 10 },
    onDiagnostic: (error, where) => diagnostics.push({ error, where }),
    ...hooks.options,
  })
  fixture.servers.push(server)
  return { server, built, diagnostics, storeErrors }
}

async function gateway(dir: string, hooks: Hooks = {}) {
  const parts = build(dir, hooks)
  return { ...parts, ...(await listenOn(parts.server)) }
}

async function call(base: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function create(base: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call(base, '/sessions', 'POST', { cwd: '/tmp', profile: 'claude-r', prompt: 'work', ...extra })
  expect(res.status).toBe(201)
  return (res.body.session as SessionInfo).id
}

function cut(base: string, id: string, expectedGeneration: number, prompt?: string) {
  return call(base, `/sessions/${id}/conversations`, 'POST', { expectedGeneration, ...(prompt ? { prompt } : {}) })
}

async function idle(server: WorkerServer, id: string): Promise<void> {
  await vi.waitFor(() => expect(server.registry.get(id)?.info().status).toBe('idle'))
  await vi.waitFor(async () => expect((await server.records.get(id))?.cut).toBeUndefined())
  await server.parking.flush()
}

async function stop(server: WorkerServer): Promise<void> {
  await server.parking.flush()
  await server.close()
  fixture.servers.splice(fixture.servers.indexOf(server), 1)
}

function fileOf(dir: string, id: string): string {
  return join(dir, 'sessions', `${encodeURIComponent(id)}.json`)
}

// The file itself, not the gateway's view of it: what a crash would leave for the next process.
async function onDisk(dir: string, id: string): Promise<SessionRecord> {
  return (JSON.parse(await readFile(fileOf(dir, id), 'utf8')) as { record: SessionRecord }).record
}

async function crashAt(fault: CutFault, prompt = 'next') {
  const dir = await fixture.stateDir()
  const first = await gateway(dir)
  const id = await create(first.base)
  await idle(first.server, id)
  const old = first.built[0]!
  first.server.cuts.faults.add(fault)
  const res = await cut(first.base, id, 1, prompt)
  await stop(first.server)
  return { dir, id, old, res, crashed: await onDisk(dir, id) }
}

describe('every fault point leaves a record the next process finishes', () => {
  it('commit: the write is rolled back in place, so the restart finds n with its own engine and nothing owed', async () => {
    const { dir, id, old, res, crashed } = await crashAt('commit')
    expect(res.status).toBe(500)
    expect(crashed).toMatchObject({ conversation: 1, conversations: [] })
    expect(crashed.cut).toBeUndefined()
    expect(crashed.pendingPrompt).toBeUndefined()
    expect(crashed.startFailed).toBeUndefined()
    expect(crashed.runtime).toMatchObject({ kind: 'dormant', sdkSessionId: old.engineName, info: { conversation: 1 } })

    const second = await gateway(dir)
    expect(second.built).toHaveLength(0)
    expect(await onDisk(dir, id)).toEqual(crashed)
    await second.server.parking.ensureLive(id)
    expect(second.built[0]!.config.resume).toBe(old.engineName)
    expect(second.built[0]!.sent).toEqual([])
  })

  it('after-stop: a prepared intent is rolled back, n resumes on its own engine and the prompt is never sent', async () => {
    const { dir, id, old, res, crashed } = await crashAt('after-stop')
    expect(res.status).toBe(500)
    expect(crashed).toMatchObject({ conversation: 1, conversations: [], cut: { from: 1, to: 2, phase: 'prepared' } })
    expect(crashed.pendingPrompt).toBeUndefined()
    expect(crashed.runtime).toMatchObject({ kind: 'dormant', sdkSessionId: old.engineName, info: { conversation: 1 } })

    const second = await gateway(dir)
    expect(second.built).toHaveLength(0)
    const recovered = await onDisk(dir, id)
    expect(recovered).toMatchObject({ conversation: 1, conversations: [] })
    expect(recovered.cut).toBeUndefined()
    expect(recovered.startFailed).toBeUndefined()
    expect(recovered.pendingPrompt).toBeUndefined()
    expect(recovered.runtime).toMatchObject({ sdkSessionId: old.engineName, info: { conversation: 1 } })
    await second.server.parking.ensureLive(id)
    expect(second.built[0]!.config.resume).toBe(old.engineName)
    expect(second.built.flatMap((runner) => runner.sent)).toEqual([])
  })

  it('after-commit: n+1 is committed with no engine pointer, and the restart starts it once with the prompt', async () => {
    const { dir, id, old, res, crashed } = await crashAt('after-commit')
    expect(res.status).toBe(500)
    expect(crashed).toMatchObject({
      conversation: 2,
      conversations: [{ n: 1, engineSessionId: old.engineName }],
      cut: { from: 1, to: 2, phase: 'committed' },
      pendingPrompt: { text: 'next', n: 2, state: 'pending' },
      runtime: { kind: 'dormant', info: { conversation: 2 } },
    })
    expect((crashed.runtime as DormantSessionRecord).sdkSessionId).toBeUndefined()
    expect(crashed.startFailed).toBeUndefined()

    const second = await gateway(dir)
    expect(second.built).toHaveLength(1)
    const fresh = second.built[0]!
    expect(fresh.config.resume).toBeUndefined()
    expect(fresh.config.epoch).toBe(crashed.cut!.epoch)
    await idle(second.server, id)
    expect(fresh.sent).toEqual(['next'])
    const recovered = await onDisk(dir, id)
    expect(recovered).toMatchObject({ conversation: 2, conversations: [{ n: 1, engineSessionId: old.engineName }] })
    expect(recovered.conversations).toHaveLength(1)
    expect(recovered.cut).toBeUndefined()
    expect(recovered.pendingPrompt).toBeUndefined()
    expect(recovered.startFailed).toBeUndefined()
    expect(recovered.runtime).toMatchObject({ sdkSessionId: fresh.engineName, info: { conversation: 2 } })
  })

  it('start: the failure is durable with the prompt still pending, and the restart starts n+1 once and sends it', async () => {
    const { dir, id, old, res, crashed } = await crashAt('start')
    expect(res.status).toBe(502)
    expect(crashed).toMatchObject({
      conversation: 2,
      conversations: [{ n: 1, engineSessionId: old.engineName }],
      cut: { phase: 'committed', to: 2 },
      startFailed: { n: 2, error: 'injected fault at start' },
      pendingPrompt: { text: 'next', n: 2, state: 'pending' },
    })
    expect((crashed.runtime as DormantSessionRecord).sdkSessionId).toBeUndefined()

    const second = await gateway(dir)
    expect(second.built).toHaveLength(1)
    await idle(second.server, id)
    expect(second.built[0]!.config.resume).toBeUndefined()
    expect(second.built[0]!.sent).toEqual(['next'])
    const recovered = await onDisk(dir, id)
    expect(recovered).toMatchObject({ conversation: 2, runtime: { sdkSessionId: second.built[0]!.engineName, info: { conversation: 2 } } })
    expect(recovered.conversations).toHaveLength(1)
    expect(recovered.cut).toBeUndefined()
    expect(recovered.startFailed).toBeUndefined()
    expect(recovered.pendingPrompt).toBeUndefined()
  })

  it('a crash between the sending mark and the start: n+1 starts without the prompt, which waits as uncertain', async () => {
    const { dir, id, crashed } = await crashAt('after-commit')
    // Rebuild the moment between `sending` and the fresh start: the committed intent, the prompt marked as handed over.
    await writeFile(
      fileOf(dir, id),
      JSON.stringify({ version: 2, record: { ...crashed, pendingPrompt: { text: 'next', n: 2, state: 'sending' } } }),
    )

    const second = await gateway(dir)
    expect(second.built).toHaveLength(1)
    await idle(second.server, id)
    expect(second.built[0]!.sent).toEqual([])
    const recovered = await onDisk(dir, id)
    expect(recovered).toMatchObject({ conversation: 2, pendingPrompt: { text: 'next', n: 2, state: 'uncertain' } })
    expect(recovered.cut).toBeUndefined()
    expect(recovered.runtime).toMatchObject({ sdkSessionId: second.built[0]!.engineName })
  })

  it('a create that crashed before its first conversation was durable starts it once and never resends its first message', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir, {
      options: { agentStartupTimeoutMs: 20 },
      building: (runner) => {
        runner.hold = new Promise(() => {})
      },
    })
    const id = await create(first.base)
    await vi.waitFor(async () => expect((await onDisk(dir, id)).pendingPrompt?.state).toBe('sending'))
    await stop(first.server)
    expect(await onDisk(dir, id)).toMatchObject({ conversation: 1, cut: { from: 0, to: 1, phase: 'committed' } })

    const second = await gateway(dir)
    expect(second.built).toHaveLength(1)
    await idle(second.server, id)
    expect(second.built[0]!.sent).toEqual([])
    const recovered = await onDisk(dir, id)
    expect(recovered).toMatchObject({ conversation: 1, conversations: [], pendingPrompt: { text: 'work', n: 1, state: 'uncertain' } })
    expect(recovered.cut).toBeUndefined()
  })
})

describe('a prompt whose delivery is not known', () => {
  it('is uncertain after a crash while sending, never resent by a restart, and sent once on request', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    expect((await cut(first.base, id, 1)).status).toBe(200)
    await idle(first.server, id)
    await first.server.records.transact(id, (current) => ({ ...current!, pendingPrompt: { text: 'maybe', n: 2, state: 'sending' } }))
    await stop(first.server)

    const second = await gateway(dir)
    expect(second.built).toHaveLength(0)
    expect((await onDisk(dir, id)).pendingPrompt).toEqual({ text: 'maybe', n: 2, state: 'uncertain' })
    await stop(second.server)

    const third = await gateway(dir)
    expect(third.built).toHaveLength(0)
    expect((await onDisk(dir, id)).pendingPrompt).toEqual({ text: 'maybe', n: 2, state: 'uncertain' })
    const sent = await call(third.base, `/sessions/${id}/conversations/pending`, 'POST', { expectedGeneration: 2, send: true })
    expect(sent.status).toBe(200)
    expect(third.built).toHaveLength(1)
    expect(third.built[0]!.sent).toEqual(['maybe'])
    expect((await onDisk(dir, id)).pendingPrompt).toBeUndefined()
    await stop(third.server)

    const fourth = await gateway(dir)
    await fourth.server.parking.ensureLive(id)
    expect(fourth.built[0]!.sent).toEqual([])
  })

  it('is dismissed without ever reaching an engine, across restarts', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    await first.server.records.transact(id, (current) => ({ ...current!, pendingPrompt: { text: 'drop', n: 1, state: 'sending' } }))
    await stop(first.server)

    const second = await gateway(dir)
    expect((await onDisk(dir, id)).pendingPrompt).toEqual({ text: 'drop', n: 1, state: 'uncertain' })
    const dismissed = await call(second.base, `/sessions/${id}/conversations/pending`, 'POST', { expectedGeneration: 1, send: false })
    expect(dismissed.status).toBe(200)
    expect((await onDisk(dir, id)).pendingPrompt).toBeUndefined()
    await stop(second.server)

    const third = await gateway(dir)
    await third.server.parking.ensureLive(id)
    expect([...second.built, ...third.built].flatMap((runner) => runner.sent)).toEqual([])
  })

  it('refuses to send an uncertain prompt into a conversation after the one it was for', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const id = await create(first.base)
    await idle(first.server, id)
    expect((await cut(first.base, id, 1)).status).toBe(200)
    await idle(first.server, id)
    // A leftover from n: the cut itself drops one, so only a record written by hand still holds it.
    await first.server.records.transact(id, (current) => ({ ...current!, pendingPrompt: { text: 'old', n: 1, state: 'uncertain' } }))
    const refused = await call(first.base, `/sessions/${id}/conversations/pending`, 'POST', { expectedGeneration: 2, send: true })
    expect(refused.status).toBe(409)
    expect((await onDisk(dir, id)).pendingPrompt).toMatchObject({ state: 'uncertain' })
    expect(first.built.at(-1)!.sent).toEqual([])
  })
})

describe('recovery is idempotent', () => {
  it('a second restart after a recovered commit cuts nothing and starts nothing', async () => {
    const { dir, id } = await crashAt('after-commit')
    const second = await gateway(dir)
    expect(second.built).toHaveLength(1)
    await idle(second.server, id)
    const successor = second.built[0]!.engineName
    const settled = await onDisk(dir, id)
    await second.server.cuts.recover((error) => {
      throw error
    })
    expect(second.built).toHaveLength(1)
    await stop(second.server)

    const third = await gateway(dir)
    expect(third.built).toHaveLength(0)
    const again = await onDisk(dir, id)
    expect(again).toMatchObject({ conversation: 2, conversations: [{ n: 1 }], runtime: { sdkSessionId: successor } })
    expect(again.conversations).toHaveLength(1)
    expect(again.cut).toBeUndefined()
    expect(again.runtime?.info.epoch).toBe(settled.runtime?.info.epoch)
    await third.server.parking.ensureLive(id)
    expect(third.built[0]!.config.resume).toBe(successor)
    expect(third.built[0]!.sent).toEqual([])
  })

  it('a prepared intent rolled back once stays rolled back', async () => {
    const { dir, id, old } = await crashAt('after-stop')
    await stop((await gateway(dir)).server)
    const third = await gateway(dir)
    expect(third.built).toHaveLength(0)
    const record = await onDisk(dir, id)
    expect(record).toMatchObject({ conversation: 1, conversations: [], runtime: { sdkSessionId: old.engineName } })
    expect(record.cut).toBeUndefined()
  })
})

describe('recovery over records it cannot read or finish', () => {
  it('reports a record whose recovery fails through onError and carries on with the others', async () => {
    const dir = await fixture.stateDir()
    const first = await gateway(dir)
    const good = await create(first.base)
    const bad = await create(first.base)
    await idle(first.server, good)
    await idle(first.server, bad)
    first.server.cuts.faults.add('after-commit')
    await cut(first.base, good, 1, 'for good')
    await cut(first.base, bad, 1, 'for bad')
    await stop(first.server)

    const second = await gateway(dir, {
      building: (runner) => {
        if (runner.id === bad) {
          throw new Error('engine refused to build')
        }
      },
    })
    const reported = second.diagnostics.filter((entry) => entry.where === 'conversation-cut')
    expect(reported).toHaveLength(1)
    expect(String(reported[0]!.error)).toContain('engine refused to build')
    await idle(second.server, good)
    expect(second.built.find((runner) => runner.id === good)!.sent).toEqual(['for good'])
    expect((await onDisk(dir, good)).cut).toBeUndefined()
    expect(await onDisk(dir, bad)).toMatchObject({
      conversation: 2,
      cut: { phase: 'committed' },
      startFailed: { n: 2 },
      pendingPrompt: { text: 'for bad', state: 'pending' },
    })
  })

  it('reports a record the store throws on and carries on with the others', async () => {
    const { dir, id } = await crashAt('after-commit')
    const other = (await onDisk(dir, id)) as SessionRecord
    await writeFile(fileOf(dir, 'locked'), JSON.stringify({ version: 2, record: { ...other, id: 'locked', runtime: undefined } }))

    const second = await gateway(dir, {
      store: (inner) => ({ ...inner, get: (key) => (key === 'locked' ? Promise.reject(new Error('EACCES: locked')) : inner.get(key)) }),
    })
    expect(second.diagnostics.some((entry) => entry.where === 'conversation-cut' && String(entry.error).includes('EACCES'))).toBe(true)
    await idle(second.server, id)
    expect(second.built.map((runner) => runner.id)).toEqual([id])
    expect((await onDisk(dir, id)).cut).toBeUndefined()
  })
})

describe('the write token across a cut and a restart', () => {
  it('refuses a save and a clear stamped with n once n+1 is committed, in a process that never saw the cut', async () => {
    const { dir, id, old } = await crashAt('after-commit')
    const second = await gateway(dir)
    await idle(second.server, id)
    const before = await onDisk(dir, id)
    const stale: DormantSessionRecord = { ...(before.runtime as DormantSessionRecord), sdkSessionId: old.engineName }
    const runtime = second.server.records.runtimeStore()
    await expect(runtime.save({ ...stale, info: { ...stale.info, conversation: 1 } })).rejects.toBeInstanceOf(StaleConversationError)
    await expect(runtime.delete(id, 1, 'ended')).rejects.toBeInstanceOf(StaleConversationError)
    await expect(runtime.delete(id, 1, 'resumed')).rejects.toBeInstanceOf(StaleConversationError)
    const after = await onDisk(dir, id)
    expect(after).toEqual(before)
    expect(after.runtime).toMatchObject({ sdkSessionId: second.built[0]!.engineName, info: { conversation: 2 } })
  })

  it('refuses a parking discard stamped with n that lands behind the commit', async () => {
    const dir = await fixture.stateDir()
    let release: (() => void) | undefined
    let reached: (() => void) | undefined
    const committing = new Promise<void>((resolve) => {
      reached = resolve
    })
    const { server, base, built } = await gateway(dir, {
      store: (inner) => ({
        ...inner,
        save: async (record) => {
          if (record.cut?.phase === 'committed' && record.cut.from > 0 && release === undefined) {
            reached!()
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          await inner.save(record)
        },
      }),
    })
    const id = await create(base)
    await idle(server, id)
    const pending = cut(base, id, 1)
    await committing
    const discard = server.parking.discard(id)
    release!()
    await expect(discard).rejects.toBeInstanceOf(StaleConversationError)
    expect((await pending).status).toBe(200)
    await idle(server, id)
    const record = await onDisk(dir, id)
    expect(record).toMatchObject({ conversation: 2, runtime: { sdkSessionId: built.at(-1)!.engineName, info: { conversation: 2 } } })
    expect(record.closedAt).toBeUndefined()
  })
})
