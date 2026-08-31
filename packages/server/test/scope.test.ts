import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import type { CreateSessionRequest, JobInfo, ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import { ParkableRunner } from './parkable-runner.ts'
import {
  createFileSessionStore,
  createWorkerServer,
  MemorySessionStore,
  sandboxedProviderProfile,
  type EngineRunnerContext,
  type WorkerServer,
} from '../src/index.ts'

let running: WorkerServer | undefined
const tempDirs: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// Echoes `config.scope` the way every real runner does — what `buildRunner` asserts on.
const fakeRunner = (id: string, config: SessionRunnerConfig): Runner => {
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

const sandboxed = (): ProfileInfo => sandboxedProviderProfile('sandboxed', { id: 'openai-compatible', model: 'test-model' })

const PRINCIPALS: Record<string, unknown> = {
  'alice-a': { scope: { space: 'a', user: 'alice' } },
  'bob-a': { scope: { space: 'a', user: 'bob' } },
  'carol-b': { scope: { space: 'b', user: 'carol' } },
  operator: {},
}

const startServer = async (extra: Parameters<typeof createWorkerServer>[0] = {}): Promise<string> => {
  let n = 0
  running = createWorkerServer({
    authenticate: (req) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const url = new URL(req.url ?? '/', 'http://internal')
      return PRINCIPALS[token || (url.searchParams.get('key') ?? '')] ?? null
    },
    profiles: [sandboxed()],
    createEngineRunner: (ctx: EngineRunnerContext) => fakeRunner(`s${++n}`, ctx.config),
    ...extra,
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

const as = (token: string): { headers: Record<string, string> } => ({
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
})

const createSession = async (base: string, token: string, body: Record<string, unknown> = {}): Promise<Response> =>
  fetch(`${base}/sessions`, { method: 'POST', ...as(token), body: JSON.stringify(body) })

const sessionIdOf = async (res: Response): Promise<string> => ((await res.json()) as { session: SessionInfo }).session.id

describe('session scope', () => {
  it('stamps the principal scope at create and echoes it on SessionInfo', async () => {
    const base = await startServer()
    const res = await createSession(base, 'alice-a')
    expect(res.status).toBe(201)
    const { session } = (await res.json()) as { session: SessionInfo }
    expect(session.scope).toEqual({ space: 'a', user: 'alice' })
    expect(session.cwd).toBe('')
  })

  it('lets a scoped caller add narrower tags but not contradict its own', async () => {
    const base = await startServer()
    const ok = await createSession(base, 'alice-a', { scope: { conversation: 'c1' } })
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { session: SessionInfo }).session.scope).toEqual({
      conversation: 'c1',
      space: 'a',
      user: 'alice',
    })

    const lie = await createSession(base, 'alice-a', { scope: { space: 'b' } })
    expect(lie.status).toBe(403)
  })

  it('refuses a malformed scope', async () => {
    const base = await startServer()
    for (const scope of [{ space: 5 }, 'a', ['a'], { '': 'x' }]) {
      const res = await createSession(base, 'operator', { scope })
      expect(res.status).toBe(400)
    }
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))
    expect((await createSession(base, 'operator', { scope: tooMany })).status).toBe(400)
  })

  it('hides another scope from the list, and shows the operator everything', async () => {
    const base = await startServer()
    await createSession(base, 'alice-a')
    await createSession(base, 'carol-b')

    const listAs = async (token: string): Promise<SessionInfo[]> =>
      ((await (await fetch(`${base}/sessions`, as(token))).json()) as { sessions: SessionInfo[] }).sessions

    expect((await listAs('alice-a')).map((s) => s.scope?.user)).toEqual(['alice'])
    expect((await listAs('carol-b')).map((s) => s.scope?.user)).toEqual(['carol'])
    expect((await listAs('operator')).length).toBe(2)
  })

  it('404s every session route for another scope, byte-identically to an unknown id', async () => {
    const base = await startServer()
    const id = await sessionIdOf(await createSession(base, 'alice-a'))

    const unknown = await fetch(`${base}/sessions/does-not-exist`, as('carol-b'))
    const expected = await unknown.text()
    expect(unknown.status).toBe(404)

    const routes: Array<[string, string, string?]> = [
      ['GET', `/sessions/${id}`],
      ['GET', `/sessions/${id}/files`],
      ['GET', `/sessions/${id}/files/out/report.json`],
      ['GET', `/sessions/${id}/produced`],
      ['GET', `/sessions/${id}/produced/f1`],
      ['GET', `/sessions/${id}/mcp`],
      ['GET', `/sessions/${id}/attachments`],
      ['POST', `/sessions/${id}/permissions/req-1`, JSON.stringify({ behavior: 'allow' })],
      ['PATCH', `/sessions/${id}`, JSON.stringify({ title: 'stolen' })],
      ['DELETE', `/sessions/${id}`],
    ]
    for (const [method, path, body] of routes) {
      const res = await fetch(`${base}${path}`, { method, ...as('carol-b'), body })
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 404`)
      expect(await res.text()).toBe(expected)
    }

    const mine = await fetch(`${base}/sessions/${id}`, as('alice-a'))
    expect(mine.status).toBe(200)
    expect(((await mine.json()) as { session: SessionInfo }).session.title).toBeUndefined()
  })

  it('lets a same-space peer through under the default rule, and a custom policy override it', async () => {
    const base = await startServer()
    const id = await sessionIdOf(await createSession(base, 'alice-a'))
    expect((await fetch(`${base}/sessions/${id}`, as('bob-a'))).status).toBe(404)
    await running?.close()

    const spaceWide = await startServer({
      authorizeSession: (principal, session) => (principal as { scope?: Record<string, string> }).scope?.space === session.scope?.space,
    })
    const id2 = await sessionIdOf(await createSession(spaceWide, 'alice-a'))
    expect((await fetch(`${spaceWide}/sessions/${id2}`, as('bob-a'))).status).toBe(200)
    expect((await fetch(`${spaceWide}/sessions/${id2}`, as('carol-b'))).status).toBe(404)
  })

  it('refuses a WS attach from another scope, and admits the owner', async () => {
    const base = await startServer()
    const id = await sessionIdOf(await createSession(base, 'alice-a'))
    const wsBase = base.replace('http', 'ws')

    const attach = (token: string): Promise<'open' | number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?key=${token}`)
        ws.on('open', () => {
          ws.close()
          resolve('open')
        })
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws.on('error', () => resolve(0))
      })

    expect(await attach('carol-b')).toBe(404)
    expect(await attach('alice-a')).toBe('open')
  })

  it('never wakes a stored session for a caller who cannot see it', async () => {
    const dir = tempDir('cw-scope-store-')
    const store = createFileSessionStore({ dir })
    const configDir = tempDir('cw-scope-wake-')
    const buildRunnerConfig = vi.fn((req: CreateSessionRequest) => ({
      ...req,
      queryFn: (() => neverQuery()) as never,
    }))
    const base = await startServer({
      profiles: [sandboxed(), { name: 'claude', configDir }],
      parking: { store },
      buildRunnerConfig,
    })
    // A dormant record for an engine that really can resume, so a wake here would genuinely rebuild a runner.
    await store.save({
      kind: 'dormant',
      id: 'stored-1',
      info: {
        id: 'stored-1',
        status: 'idle',
        cwd: configDir,
        profile: 'claude',
        createdAt: Date.now(),
        lastSeq: 0,
        pendingPermissionCount: 0,
        scope: { space: 'a', user: 'alice' },
      },
      config: { cwd: configDir, profile: 'claude', scope: { space: 'a', user: 'alice' } },
      sdkSessionId: 'engine-1',
      savedAt: Date.now(),
    })

    const wsBase = base.replace('http', 'ws')
    const attach = (token: string): Promise<number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${wsBase}/sessions/stored-1/ws?key=${token}`)
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws.on('open', () => {
          ws.close()
          resolve(200)
        })
        ws.on('error', () => resolve(0))
      })

    expect(await attach('carol-b')).toBe(404)
    expect(buildRunnerConfig).not.toHaveBeenCalled()
    expect((await store.get('stored-1'))?.id).toBe('stored-1')
    expect(await attach('alice-a')).toBe(200)
    expect(buildRunnerConfig).toHaveBeenCalledOnce()
    expect(buildRunnerConfig.mock.calls[0]![0].scope).toEqual({ space: 'a', user: 'alice' })
  })

  it('survives a restart with its scope intact', async () => {
    const dir = tempDir('cw-scope-restart-')
    const base = await startServer({ parking: { store: createFileSessionStore({ dir }) } })
    // The provider engine writes no dormant record, so this round-trip is asserted on the store directly.
    const store = createFileSessionStore({ dir })
    await store.save({
      kind: 'dormant',
      id: 'restarted-1',
      info: {
        id: 'restarted-1',
        status: 'idle',
        cwd: '',
        createdAt: Date.now(),
        lastSeq: 0,
        pendingPermissionCount: 0,
        scope: { space: 'b', user: 'carol' },
      },
      config: { profile: 'sandboxed', scope: { space: 'b', user: 'carol' } },
      sdkSessionId: 'engine-9',
      savedAt: Date.now(),
    })
    await running?.close()

    const revived = await startServer({ parking: { store: createFileSessionStore({ dir }) } })
    const listAs = async (token: string): Promise<SessionInfo[]> =>
      (
        (await (await fetch(`${revived}/sessions`, as(token))).json()) as {
          sessions: SessionInfo[]
        }
      ).sessions
    expect((await listAs('carol-b')).map((s) => s.id)).toContain('restarted-1')
    expect((await listAs('alice-a')).map((s) => s.id)).not.toContain('restarted-1')
    expect(base).toBeTruthy()
  })

  it('refuses the operator-only surfaces to a scoped principal', async () => {
    const roots = tempDir('cw-scope-fs-')
    const base = await startServer({
      allowedCwdRoots: [roots],
      hostFiles: { roots: [roots] },
      queue: { maxConcurrency: 1 },
    })
    for (const path of ['/fs/list?path=' + encodeURIComponent(roots), '/sdk-sessions', '/queue']) {
      expect((await fetch(`${base}${path}`, as('alice-a'))).status).toBe(404)
    }
    expect((await fetch(`${base}/queue`, as('operator'))).status).toBe(200)

    const wsBase = base.replace('http', 'ws')
    const queueStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${wsBase}/queue/ws?key=alice-a`)
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => {
        ws.close()
        resolve(200)
      })
      ws.on('error', () => resolve(0))
    })
    expect(queueStatus).toBe(404)
  })

  it('scopes jobs, so the queue is not a side door', async () => {
    const base = await startServer({ queue: { maxConcurrency: 0 } })
    const submit = async (token: string): Promise<JobInfo> => {
      const res = await fetch(`${base}/jobs`, {
        method: 'POST',
        ...as(token),
        body: JSON.stringify({ session: { profile: 'sandboxed', prompt: 'do the thing' } }),
      })
      expect(res.status).toBe(201)
      return ((await res.json()) as { job: JobInfo }).job
    }
    const mine = await submit('alice-a')
    expect(mine.scope).toEqual({ space: 'a', user: 'alice' })
    await submit('carol-b')

    const listAs = async (token: string): Promise<JobInfo[]> =>
      ((await (await fetch(`${base}/jobs`, as(token))).json()) as { jobs: JobInfo[] }).jobs
    expect((await listAs('alice-a')).map((j) => j.id)).toEqual([mine.id])
    expect((await listAs('operator')).length).toBe(2)

    expect((await fetch(`${base}/jobs/${mine.id}`, as('carol-b'))).status).toBe(404)
    expect((await fetch(`${base}/jobs/${mine.id}`, { method: 'DELETE', ...as('carol-b') })).status).toBe(404)
    const still = await fetch(`${base}/jobs/${mine.id}`, as('alice-a'))
    expect(((await still.json()) as { job: JobInfo }).job.status).toBe('queued')
  })

  it('withdraws the unscoped-means-operator default once a policy is declared', async () => {
    const roots = tempDir('cw-scope-tenant-')
    const TENANTS: Record<string, unknown> = {
      t1: { tenant: 'one' },
      t2: { tenant: 'two' },
      admin: { tenant: 'one', operator: true },
    }
    running = createWorkerServer({
      authenticate: (req) => {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        const url = new URL(req.url ?? '/', 'http://internal')
        return TENANTS[token || (url.searchParams.get('key') ?? '')] ?? null
      },
      authorizeSession: (principal, session) => (principal as { tenant?: string }).tenant === session.scope?.tenant,
      profiles: [sandboxed()],
      createEngineRunner: (ctx: EngineRunnerContext) => fakeRunner('t-1', ctx.config),
      allowedCwdRoots: [roots],
      hostFiles: { roots: [roots] },
      queue: { maxConcurrency: 0 },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const created = await fetch(`${base}/sessions`, {
      method: 'POST',
      ...as('t1'),
      body: JSON.stringify({ scope: { tenant: 'one' } }),
    })
    const id = await sessionIdOf(created)
    expect((await fetch(`${base}/sessions/${id}`, as('t2'))).status).toBe(404)
    expect((await fetch(`${base}/sessions/${id}`, as('t1'))).status).toBe(200)

    for (const token of ['t1', 't2']) {
      for (const path of ['/fs/list?path=' + encodeURIComponent(roots), '/sdk-sessions', '/queue']) {
        expect(`${token} ${path} → ${(await fetch(`${base}${path}`, as(token))).status}`).toBe(`${token} ${path} → 404`)
      }
    }
    expect((await fetch(`${base}/queue`, as('admin'))).status).toBe(200)
    expect((await fetch(`${base}/fs/list?path=${encodeURIComponent(roots)}`, as('admin'))).status).toBe(200)

    const asTenant = await fetch(`${base}/profiles/sandboxed`, as('t1'))
    expect(asTenant.status).toBe(200)
    expect(((await asTenant.json()) as { config?: unknown }).config).toBeUndefined()
    expect(
      (
        (await (await fetch(`${base}/profiles/sandboxed`, as('admin'))).json()) as {
          config?: unknown
        }
      ).config,
    ).toBeDefined()
  })

  it('runs a policy narrower than tag-match over queued jobs too', async () => {
    running = createWorkerServer({
      authenticate: (req) => {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        return PRINCIPALS[token] ?? null
      },
      authorizeSession: (principal, session) =>
        session.scope?.space === (principal as { scope?: Record<string, string> }).scope?.space &&
        (principal as { scope?: Record<string, string> }).scope?.user === 'alice',
      profiles: [sandboxed()],
      createEngineRunner: (ctx: EngineRunnerContext) => fakeRunner('j-1', ctx.config),
      queue: { maxConcurrency: 0 },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    // Submitted BY bob, so plain tag-match would admit him — only the policy says no, which is the discrimination under test.
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      ...as('bob-a'),
      body: JSON.stringify({ session: { profile: 'sandboxed', prompt: 'x' } }),
    })
    expect(res.status).toBe(201)
    const { job } = (await res.json()) as { job: JobInfo }
    expect(job.scope).toEqual({ space: 'a', user: 'bob' })

    expect((await fetch(`${base}/jobs/${job.id}`, as('bob-a'))).status).toBe(404)
    expect(((await (await fetch(`${base}/jobs`, as('bob-a'))).json()) as { jobs: JobInfo[] }).jobs).toEqual([])
    expect((await fetch(`${base}/jobs/${job.id}`, { method: 'DELETE', ...as('bob-a') })).status).toBe(404)
    expect((await fetch(`${base}/jobs/${job.id}`, as('alice-a'))).status).toBe(200)
  })

  it('treats a policy that throws as a refusal rather than a 500', async () => {
    const base = await startServer({
      authorizeSession: (_principal, session) => {
        if (session.scope?.user === 'carol') {
          throw new Error('policy exploded')
        }
        return true
      },
    })
    await createSession(base, 'alice-a')
    await createSession(base, 'carol-b')
    const list = await fetch(`${base}/sessions`, as('alice-a'))
    expect(list.status).toBe(200)
    expect(((await list.json()) as { sessions: SessionInfo[] }).sessions).toHaveLength(1)
  })

  it('refuses an execution result from another scope', async () => {
    // Needs a real parked execution, not just an unknown id: the claim is that the result never reaches the loop.
    const parkable: ParkableRunner[] = []
    running = createWorkerServer({
      authenticate: (req) => PRINCIPALS[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
      profiles: [sandboxed()],
      parking: { parkDelayMs: 10 },
      createEngineRunner: ({ config, restore }) => {
        const runner = new ParkableRunner(restore?.id ?? `p${parkable.length + 1}`, config, restore)
        parkable.push(runner)
        return runner
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const id = await sessionIdOf(await createSession(base, 'alice-a'))
    parkable[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(id)).not.toBeNull())

    const post = (token: string, executionId: string): Promise<Response> =>
      fetch(`${base}/executions/${executionId}/result`, {
        method: 'POST',
        ...as(token),
        body: JSON.stringify({ status: 'ok', output: { value: 'forged' } }),
      })

    const refused = await post('carol-b', 'exec-1')
    expect(refused.status).toBe(404)
    expect(await refused.text()).toBe(await (await post('carol-b', 'no-such-exec')).text())
    expect(parkable.some((r) => r.settled.length > 0)).toBe(false)

    expect((await post('alice-a', 'exec-1')).status).toBe(200)
    expect(parkable.at(-1)!.settled.map((s) => s.executionId)).toEqual(['exec-1'])
  })

  it('404s an orphaned execution byte-identically, never disclosing its owner', async () => {
    // The exposed state: parking still maps the execution to its owner while the session is in neither registry nor store (record lost).
    // The first refused submit settles the id; the second must not answer 200 with the sessionId.
    const store = new MemorySessionStore()
    const parkable: ParkableRunner[] = []
    running = createWorkerServer({
      authenticate: (req) => PRINCIPALS[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
      profiles: [sandboxed()],
      parking: { parkDelayMs: 10, store },
      createEngineRunner: ({ config, restore }) => {
        const runner = new ParkableRunner(restore?.id ?? `q${parkable.length + 1}`, config, restore)
        parkable.push(runner)
        return runner
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const id = await sessionIdOf(await createSession(base, 'alice-a'))
    parkable[0]!.defer('exec-9')
    await vi.waitFor(async () => expect(await store.get(id)).not.toBeNull())
    await store.delete(id)

    const post = (token: string, executionId: string): Promise<Response> =>
      fetch(`${base}/executions/${executionId}/result`, {
        method: 'POST',
        ...as(token),
        body: JSON.stringify({ status: 'ok', output: { value: 'forged' } }),
      })

    const expected = await (await post('carol-b', 'no-such-exec')).text()
    const first = await post('carol-b', 'exec-9')
    const second = await post('carol-b', 'exec-9')
    const secondText = await second.text()
    expect(secondText).not.toContain(id)
    expect(second.status).toBe(404)
    expect(secondText).toBe(expected)
    expect(first.status).toBe(404)
    expect(await first.text()).toBe(expected)
    expect((await post('alice-a', 'exec-9')).status).toBe(404)
    expect(parkable.some((r) => r.settled.length > 0)).toBe(false)
  })

  it('refuses a runner that does not echo its scope', async () => {
    const base = await startServer({
      createEngineRunner: (ctx: EngineRunnerContext) => fakeRunner('forgetful', { ...ctx.config, scope: undefined }),
    })
    const res = await createSession(base, 'alice-a')
    expect(res.status).toBe(500)
    expect(await res.text()).toMatch(/echo config\.scope/)
  })
})

describe('cwd for a filesystem-less engine', () => {
  it('accepts a session with no cwd and still requires one for claude', async () => {
    const configDir = tempDir('cw-scope-claude-')
    const base = await startServer({
      profiles: [sandboxed(), { name: 'claude', configDir }],
      buildRunnerConfig: (req) => ({ ...req, queryFn: (() => neverQuery()) as never }),
    })
    expect((await createSession(base, 'operator', { profile: 'sandboxed' })).status).toBe(201)
    const missing = await createSession(base, 'operator', { profile: 'claude' })
    expect(missing.status).toBe(400)
    expect(await missing.text()).toMatch(/cwd is required/)
  })

  it('still validates a cwd the caller went out of its way to name', async () => {
    const roots = tempDir('cw-scope-roots-')
    const base = await startServer({ allowedCwdRoots: [roots] })
    expect((await createSession(base, 'operator', { profile: 'sandboxed', cwd: '/etc' })).status).toBe(403)
    expect((await createSession(base, 'operator', { profile: 'sandboxed', cwd: roots })).status).toBe(201)
  })
})

// A query that never yields — the claude sessions here are only ever built.
const neverQuery = () => {
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => new Promise<never>(() => {}),
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  }
}
