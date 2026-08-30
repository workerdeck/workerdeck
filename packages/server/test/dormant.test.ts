import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { ProfileInfo, SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer, type SessionStore, type WorkerServer } from '../src/index.ts'

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
  /** Mirrors the real runner, where `info().meta` IS the live `#config.meta` —
   * which is what a rename writes and what the dormant record must capture. */
  #meta: Record<string, unknown> | undefined

  constructor(id: string, config: SessionRunnerConfig) {
    this.id = id
    this.config = config
    this.#meta = config.meta
  }

  /** Every turn this runner was asked to take, in order — what proves a wake
   * does not quietly re-run the session's opening prompt. */
  readonly sent: string[] = []

  /** What every engine does on its way up: name the session it is running, and
   * send the opening prompt if it was given one (`SessionRunner.start` and
   * `CodexRunner` both do this unconditionally — the behaviour under test). */
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
      // The real `#title()`'s precedence, which the wake depends on: an explicit
      // `meta.title`, else one derived from the opening prompt.
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
  /** A conversation reset, in both the shapes real engines produce it: one that
   * names the fresh engine session in the same breath (claude, and codex when
   * its child is already up), and one that has no id to name until its next
   * turn (codex with no live child). */
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
  for (const server of servers.splice(0)) {
    await server.close()
  }
  // retries: a wake-up's own save can still be in flight as the server closes.
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/** Start a gateway over `store`. Calling it twice with the same store is the
 * restart this whole feature is about. */
const startGateway = async (store: SessionStore): Promise<Gateway> => {
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

const create = async (base: string, profileName = 'resumable', prompt?: string): Promise<SessionInfo> => {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: profileName, prompt }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

const rename = async (base: string, id: string, title: string): Promise<SessionInfo> => {
  const res = await fetch(`${base}/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

const list = async (base: string): Promise<SessionInfo[]> =>
  ((await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }).sessions

const stateDir = async (): Promise<string> => {
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

  it('wakes under the name it was renamed to, not the one it was built with', async () => {
    const dir = await stateDir()
    const first = await startGateway(createFileSessionStore({ dir }))
    const session = await create(first.base)
    await vi.waitFor(async () => {
      expect(await createFileSessionStore({ dir }).get(session.id)).not.toBeNull()
    })

    const renamed = await rename(first.base, session.id, 'The one I named')
    expect(renamed.title).toBe('The one I named')
    // A rename emits no event, so the re-save is the route's own doing.
    await vi.waitFor(async () => {
      const record = await createFileSessionStore({ dir }).get(session.id)
      expect((record as { config: SessionRunnerConfig }).config.meta?.title).toBe('The one I named')
    })

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await startGateway(createFileSessionStore({ dir }))
    // The listing reads `record.info`, so it was never the half that broke.
    expect((await list(second.base))[0]!.title).toBe('The one I named')

    // The wake is: it rebuilds from `record.config` and discards `record.info`,
    // so a config still carrying the build-time meta resurrects the old title.
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
    // The original run really does send it — that is what must not happen twice.
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
    // The thread comes back from the engine's own store; the prompt that opened
    // it is history, not an instruction to carry out again.
    expect(woken.config.resume).toBe('engine-session-1')
    expect(woken.sent).toEqual([])
    expect(woken.config.prompt).toBeUndefined()
    // And dropping it must not cost the session the name it derived from it.
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
    // The record names the conversation that was just cleared, and no
    // `status_changed` follows a clear to correct it — so a restart in this
    // window would wake the session straight back into the transcript the user
    // threw away. Codex is the engine that gets here: its fresh thread id is not
    // known until the next turn's `thread/start`, so with no live child there is
    // nothing to re-save under.
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
    // The live session is untouched — this is narrower than `discard`, which
    // would also drop the config and cost the session its ability to go dormant
    // again for the rest of its life.
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
