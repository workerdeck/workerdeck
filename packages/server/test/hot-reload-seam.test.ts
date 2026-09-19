import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { EngineAdapter, Runner, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionEvent, type SessionEventBody, type SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, reloadPlan, type SessionStore, type StoredSessionRecord, type WorkerServer } from '../src/index.ts'
import { ParkableRunner } from './parkable-runner.ts'

// An engine that runs behind a child process: no `snapshot`, no `park`, resume-capable. This is the shape that a
// hot reload carries by identity, and the shape the in-repo claude and codex adapters have.
class CarryRunner implements Runner {
  readonly id: string
  readonly createdAt = Date.now()
  readonly pendingApprovals = []
  closedWith: string | undefined
  #config: SessionRunnerConfig
  #events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0
  #sdkSessionId: string | undefined
  #status: SessionInfo['status'] = 'idle'

  constructor(id: string, config: SessionRunnerConfig) {
    this.id = id
    this.#config = config
  }

  init(sdkSessionId: string): void {
    this.#sdkSessionId = sdkSessionId
    this.#emit({
      type: 'system_init',
      sdkSessionId,
      model: 'test',
      cwd: this.#config.cwd ?? '/tmp',
      apiKeySource: 'none',
      tools: [],
      skills: [],
      slashCommands: [],
      permissionMode: 'default',
      claudeCodeVersion: 'test',
      mcpServers: [],
    })
  }

  work(): void {
    this.#status = 'running'
    this.#emit({ type: 'status_changed', status: 'running' })
  }

  askPermission(requestId: string): void {
    this.#emit({
      type: 'permission_requested',
      request: { id: requestId, toolName: 'Write', input: {}, toolUseId: `use-${requestId}` },
    })
  }

  async start(): Promise<void> {}
  info(): SessionInfo {
    return {
      id: this.id,
      status: this.#status,
      cwd: this.#config.cwd ?? '',
      profile: this.#config.profile,
      engine: 'claude',
      capabilities: ENGINE_CAPABILITIES.claude,
      sdkSessionId: this.#sdkSessionId,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      scope: this.#config.scope,
      meta: this.#config.meta,
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
    return true
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  close(reason: 'client' | 'server' | 'error' = 'server'): void {
    this.closedWith = reason
    this.#status = 'closed'
    this.#emit({ type: 'session_closed', reason })
  }

  #emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: Date.now() } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
}

let configDir: string
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wd-seam-'))
})
afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

function countingStore(): SessionStore & { saves: number; deletes: number } {
  const records = new Map<string, StoredSessionRecord>()
  return {
    saves: 0,
    deletes: 0,
    async save(record) {
      this.saves++
      records.set(record.id, record)
    },
    async get(id) {
      return records.get(id) ?? null
    },
    async list() {
      return [...records.values()]
    },
    async delete(id) {
      this.deletes++
      return records.delete(id)
    },
  }
}

type Built = { server: WorkerServer; runners: CarryRunner[]; notifications: string[] }

function build(store: SessionStore, notifications: string[]): Built {
  const runners: CarryRunner[] = []
  const adapter: EngineAdapter = {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => {
      const runner = new CarryRunner(id ?? `session-${runners.length + 1}`, config)
      runners.push(runner)
      return runner
    },
  }
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [{ name: 'claude', configDir }],
    engines: { claude: adapter },
    parking: { store },
    notifications: { onNotification: (notification) => notifications.push(`${notification.type}:${notification.session.id}`) },
  })
  return { server, runners, notifications }
}

let open: WorkerServer[] = []
afterEach(async () => {
  for (const server of open) {
    await server.close()
  }
  open = []
})

async function startWith(store: SessionStore, notifications: string[]): Promise<Built & { base: string }> {
  const built = build(store, notifications)
  open.push(built.server)
  const { port } = await built.server.listen(0, '127.0.0.1')
  return { ...built, base: `http://127.0.0.1:${port}/v1` }
}

describe('reloadPlan', () => {
  it('carries a session whose engine lives behind a child process', () => {
    expect(reloadPlan(new CarryRunner('a', { cwd: '/tmp' } as SessionRunnerConfig))).toBe('carry')
  })

  it('persists a session that can snapshot itself, because its executors hold this generation bridge hub', () => {
    expect(reloadPlan(new ParkableRunner('b', { cwd: '/tmp' } as SessionRunnerConfig))).toBe('persist')
  })

  it('drops a session the queue owns, and one that has already ended', () => {
    const job = new CarryRunner('c', { cwd: '/tmp', meta: { jobId: 'job-1' } } as SessionRunnerConfig)
    expect(reloadPlan(job)).toBe('drop')
    const ended = new CarryRunner('d', { cwd: '/tmp' } as SessionRunnerConfig)
    ended.close()
    expect(reloadPlan(ended)).toBe('drop')
  })
})

describe('the hot-reload seam', () => {
  it('hands a live session between two servers with exactly one of everything attached', async () => {
    const store = countingStore()
    const notifications: string[] = []
    const first = await startWith(store, notifications)

    const created = (await (
      await fetch(`${first.base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', profile: 'claude' }),
      })
    ).json()) as { session: SessionInfo }
    const runner = first.runners[0]!
    runner.init('sdk-1')
    await first.server.parking.flush()
    expect(await store.get(created.session.id)).not.toBeNull()

    const carried = first.server.releaseSession(created.session.id)
    expect(carried?.runner).toBe(runner)
    // The config is the one fact the next server cannot rederive: a durable record strips env and the function
    // fields, and before system_init there is no record at all.
    expect(carried?.config?.cwd).toBe('/tmp')
    await first.server.close()
    expect(runner.closedWith).toBeUndefined()

    const second = build(store, notifications)
    open.push(second.server)
    expect(second.server.adoptSession(carried!)).toBe(true)
    await second.server.listen(0, '127.0.0.1')

    // One notification, not one per generation: the first server's watchers came off at release.
    notifications.length = 0
    runner.askPermission('req-1')
    // The notifier hops a microtask before it sends, so the count is only meaningful after one.
    await Promise.resolve()
    expect(notifications).toEqual([`permission_requested:${created.session.id}`])

    // And the second server is really watching it now: a close discards the record, which is the half that a bare
    // `registry.register` silently loses.
    const before = store.deletes
    runner.close('client')
    await second.server.parking.flush()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.deletes).toBe(before + 1)
    expect(await store.get(created.session.id)).toBeNull()
  })

  it('stops writing through a session it has released', async () => {
    const store = countingStore()
    const first = await startWith(store, [])
    const created = (await (
      await fetch(`${first.base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', profile: 'claude' }),
      })
    ).json()) as { session: SessionInfo }
    const runner = first.runners[0]!
    runner.init('sdk-1')
    await first.server.parking.flush()

    first.server.releaseSession(created.session.id)
    const saves = store.saves
    runner.work()
    await first.server.parking.flush()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.saves).toBe(saves)
  })

  it('refuses to carry a session that must persist instead', async () => {
    const store = countingStore()
    const runners: ParkableRunner[] = []
    const server = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [{ name: 'kimi', engine: 'provider', provider: { id: 'moonshotai', model: 'kimi-k3' } }],
      parking: { store },
      createEngineRunner: ({ config }) => {
        const runner = new ParkableRunner(`session-${runners.length + 1}`, config)
        runners.push(runner)
        return runner
      },
    })
    open.push(server)
    const { port } = await server.listen(0, '127.0.0.1')
    const created = (await (
      await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp', profile: 'kimi' }),
      })
    ).json()) as { session: SessionInfo }

    expect(() => server.releaseSession(created.session.id)).toThrow(/cannot be carried/)
  })

  it('refuses to adopt a session that ended while it was held', () => {
    const store = countingStore()
    const second = build(store, [])
    open.push(second.server)
    const runner = new CarryRunner('held', { cwd: '/tmp' } as SessionRunnerConfig)
    runner.close('error')
    expect(second.server.adoptSession({ runner })).toBe(false)
    expect(second.server.registry.get('held')).toBeUndefined()
  })
})
