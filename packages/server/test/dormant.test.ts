import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { ProfileInfo, SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer, type SessionStore, type WorkerServer } from '../src/index.ts'

// Stands in for claude/codex: no `park()`, but resumable from an engine-owned store keyed by `sdkSessionId`.
class ResumableRunner implements Runner {
  readonly id: string
  readonly createdAt = Date.now()
  readonly pendingApprovals = []
  readonly config: SessionRunnerConfig
  #status: SessionInfo['status'] = 'starting'
  #events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0
  #sdkSessionId: string | undefined
  #meta: Record<string, unknown> | undefined

  constructor(id: string, config: SessionRunnerConfig) {
    this.id = id
    this.config = config
    this.#meta = config.meta
  }

  readonly sent: string[] = []

  // Both real engines name their session and send `prompt` unconditionally on start — the behaviour under test.
  async start(): Promise<void> {
    this.#sdkSessionId = this.config.resume ?? 'engine-session-1'
    if (this.config.prompt) {
      this.sendMessage(this.config.prompt)
    }
    this.#emit({
      type: 'system_init',
      sdkSessionId: this.#sdkSessionId,
      model: 'test-model',
      cwd: this.config.cwd ?? '',
      apiKeySource: 'user',
      tools: [],
      skills: [],
      slashCommands: [],
      permissionMode: 'default',
      claudeCodeVersion: 'test',
      mcpServers: [],
    })
    this.#status = 'idle'
    this.#emit({ type: 'status_changed', status: 'idle' })
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.config.cwd ?? '',
      profile: this.config.profile,
      engine: 'provider',
      capabilities: { ...ENGINE_CAPABILITIES.provider, resume: true, resumeBackfill: true },
      model: 'test-model',
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      meta: this.#meta,
      title: typeof this.#meta?.title === 'string' ? this.#meta.title : this.config.prompt || undefined,
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
  sendMessage(text: string): void {
    this.sent.push(text)
  }
  setTitle(title: string | undefined): void {
    const meta = { ...this.#meta }
    if (title) {
      meta.title = title
    } else {
      delete meta.title
    }
    this.#meta = meta
  }
  resolvePermission(): boolean {
    return false
  }
  async interrupt(): Promise<void> {}
  async clearContext(adopt?: string): Promise<void> {
    this.#sdkSessionId = adopt
    this.#emit({ type: 'conversation_reset', sdkSessionId: adopt })
  }
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  close(): void {
    this.#emit({ type: 'session_closed', reason: 'server' })
  }

  #emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: Date.now() } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
}

class UnresumableRunner extends ResumableRunner {
  override info(): SessionInfo {
    return { ...super.info(), capabilities: ENGINE_CAPABILITIES.provider }
  }
}

function profile(name: string): ProfileInfo {
  return {
    name,
    engine: 'provider',
    provider: { id: 'test', model: 'test-model' },
  }
}

type Gateway = {
  server: WorkerServer
  base: string
  built: ResumableRunner[]
}

const servers: WorkerServer[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
  // Retried: a wake-up's own save can still be in flight as the server closes.
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function startGateway(store: SessionStore): Promise<Gateway> {
  const built: ResumableRunner[] = []
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile('resumable'), profile('plain')],
    parking: { store, parkDelayMs: 10 },
    createEngineRunner: ({ config, profile: p, id }) => {
      const runner =
        p.name === 'plain'
          ? new UnresumableRunner(id ?? `session-${built.length + 1}`, config)
          : new ResumableRunner(id ?? `session-${built.length + 1}`, config)
      built.push(runner)
      return runner
    },
  })
  servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, base: `http://127.0.0.1:${port}/v1`, built }
}

async function create(base: string, profileName = 'resumable', prompt?: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: profileName, prompt }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

async function rename(base: string, id: string, title: string): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

async function list(base: string): Promise<SessionInfo[]> {
  return ((await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }).sessions
}

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wd-dormant-'))
  dirs.push(dir)
  return dir
}

describe('sessions that survive a restart', () => {
  it('remembers a live session once the engine names it, without double-listing it', async () => {
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store)
    const session = await create(gateway.base)

    await vi.waitFor(async () => {
      expect((await store.get(session.id))?.kind).toBe('dormant')
    })
    const rows = await list(gateway.base)
    expect(rows.filter((row) => row.id === session.id)).toHaveLength(1)
    expect(rows[0]!.status).not.toBe('idle-duplicate')
  })

  it('lists the session after a restart and resumes it on attach, under the same id', async () => {
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base)
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    const rows = await list(second.base)
    expect(rows.map((row) => row.id)).toEqual([session.id])
    expect(rows[0]!.status).toBe('idle')
    expect(rows[0]!.cwd).toBe('/tmp/project')
    expect(second.built).toHaveLength(0)

    const ws = new WebSocket(`${second.base.replace('http', 'ws')}/sessions/${session.id}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()

    expect(second.built).toHaveLength(1)
    const rebuilt = second.built[0]!
    expect(rebuilt.id).toBe(session.id)
    expect(rebuilt.config.resume).toBe('engine-session-1')
  })

  it('wakes under the name it was renamed to, not the one it was built with', async () => {
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base)
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })

    const renamed = await rename(first.base, session.id, 'The one I named')
    expect(renamed.title).toBe('The one I named')
    await vi.waitFor(async () => {
      const record = await createFileSessionStore({ dir }).get(session.id)
      expect((record as { config: SessionRunnerConfig }).config.meta?.title).toBe('The one I named')
    })

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    expect((await list(second.base))[0]!.title).toBe('The one I named')

    const ws = new WebSocket(`${second.base.replace('http', 'ws')}/sessions/${session.id}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()

    expect(second.built[0]!.config.meta?.title).toBe('The one I named')
    expect(second.built[0]!.info().title).toBe('The one I named')
  })

  it('does not re-run the opening prompt on a wake, and keeps the name it derived from it', async () => {
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base, 'resumable', 'Summarize the repo')
    expect(first.built[0]!.sent).toEqual(['Summarize the repo'])
    expect(session.title).toBe('Summarize the repo')
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    const ws = new WebSocket(`${second.base.replace('http', 'ws')}/sessions/${session.id}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()

    const woken = second.built[0]!
    expect(woken.config.resume).toBe('engine-session-1')
    expect(woken.sent).toEqual([])
    expect(woken.config.prompt).toBeUndefined()
    expect(woken.info().title).toBe('Summarize the repo')
  })

  it('writes nothing for an engine that cannot resume — it would come back empty', async () => {
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store)
    const session = await create(gateway.base, 'plain')
    // Give the save every chance to happen before asserting it did not.
    await vi.waitFor(async () => {
      expect((await list(gateway.base)).find((row) => row.id === session.id)?.status).toBe('idle')
    })
    expect(await store.get(session.id)).toBeNull()
  })

  it('forgets a session that ends, so a restart does not resurrect it', async () => {
    const dir = await stateDir()
    const store = createFileSessionStore({ dir })
    const gateway = await startGateway(store)
    const session = await create(gateway.base)
    await vi.waitFor(async () => {
      expect(await store.get(session.id)).not.toBeNull()
    })

    const res = await fetch(`${gateway.base}/sessions/${session.id}`, { method: 'DELETE' })
    expect(res.status).toBeLessThan(300)
    await vi.waitFor(async () => {
      expect(await store.get(session.id)).toBeNull()
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps the record when a resumed session is woken, so the next restart still finds it', async () => {
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base)
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    const ws = new WebSocket(`${second.base.replace('http', 'ws')}/sessions/${session.id}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()
    await second.server.close()
    servers.splice(servers.indexOf(second.server), 1)

    const third = await startGateway(createFileSessionStore({ dir }))
    expect((await list(third.base)).map((row) => row.id)).toEqual([session.id])
  })

  it('forgets the dormant record when a clear leaves nothing to come back to', async () => {
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store)
    const session = await create(gateway.base)
    await vi.waitFor(async () => {
      expect((await store.get(session.id))?.kind).toBe('dormant')
    })

    await gateway.built[0]!.clearContext()

    await vi.waitFor(async () => {
      expect(await store.get(session.id)).toBeNull()
    })
    expect((await list(gateway.base)).map((row) => row.id)).toEqual([session.id])
  })

  it('re-saves under the new engine session when a clear adopts one', async () => {
    const store = await stateDir().then((dir) => createFileSessionStore({ dir }))
    const gateway = await startGateway(store)
    const session = await create(gateway.base)
    await vi.waitFor(async () => {
      expect((await store.get(session.id))?.kind).toBe('dormant')
    })

    await gateway.built[0]!.clearContext('engine-session-2')

    await vi.waitFor(async () => {
      const record = await store.get(session.id)
      expect(record && record.kind === 'dormant' ? record.sdkSessionId : undefined).toBe('engine-session-2')
    })
  })
})
