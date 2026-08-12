import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { ProfileInfo, SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import {
  createFileSessionStore,
  createWorkerServer,
  type SessionStore,
  type WorkerServer,
} from '../src/index.ts'

/**
 * A runner standing in for claude/codex: it cannot park (no `park()`), but it
 * *can* resume — its transcript lives in an engine-owned store keyed by
 * `sdkSessionId`, which is the whole premise of a dormant record. `resumeBackfill`
 * is what the real engines do with the replay; nothing here depends on it.
 */
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

  constructor(id: string, config: SessionRunnerConfig) {
    this.id = id
    this.config = config
  }

  /** What every engine does on its way up: name the session it is running. */
  async start(): Promise<void> {
    this.#sdkSessionId = this.config.resume ?? 'engine-session-1'
    this.#emit({
      type: 'system_init',
      sdkSessionId: this.#sdkSessionId,
      model: 'test-model',
      cwd: this.config.cwd,
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
      cwd: this.config.cwd,
      profile: this.config.profile,
      engine: 'provider',
      capabilities: { ...ENGINE_CAPABILITIES.provider, resume: true, resumeBackfill: true },
      model: 'test-model',
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
    }
  }

  subscribe(listener: (event: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.#events) if (event.seq > afterSeq) listener(event)
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
  close(): void {
    this.#emit({ type: 'session_closed', reason: 'server' })
  }

  #emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: Date.now() } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) listener(event)
  }
}

/** A provider profile whose runner cannot resume — the control case. */
class UnresumableRunner extends ResumableRunner {
  override info(): SessionInfo {
    return { ...super.info(), capabilities: ENGINE_CAPABILITIES.provider }
  }
}

const profile = (name: string): ProfileInfo => ({
  name,
  engine: 'provider',
  provider: { id: 'test', model: 'test-model' },
})

type Gateway = {
  server: WorkerServer
  base: string
  built: ResumableRunner[]
}

const servers: WorkerServer[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  // retries: a wake-up's own save can still be in flight as the server closes.
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** Start a gateway over `store`. Calling it twice with the same store is the
 * restart this whole feature is about. */
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

const create = async (base: string, profileName = 'resumable'): Promise<SessionInfo> => {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: profileName }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

const list = async (base: string): Promise<SessionInfo[]> =>
  ((await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }).sessions

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
    // The registry owns it while it is live — the record is the way back, not a
    // second row.
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

    // The restart. A close is not a session end: the records stay.
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    const rows = await list(second.base)
    expect(rows.map((row) => row.id)).toEqual([session.id])
    // Not 'starting' and not 'running': nothing is running it.
    expect(rows[0]!.status).toBe('idle')
    expect(rows[0]!.cwd).toBe('/tmp/project')
    // Lazily: listing fifty sessions must not spawn fifty engines.
    expect(second.built).toHaveLength(0)

    // Attaching is what wakes it.
    const ws = new WebSocket(`${second.base.replace('http', 'ws')}/sessions/${session.id}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.close()

    expect(second.built).toHaveLength(1)
    const rebuilt = second.built[0]!
    expect(rebuilt.id).toBe(session.id)
    // The transcript comes back from the engine's own store, not from ours.
    expect(rebuilt.config.resume).toBe('engine-session-1')
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
})
