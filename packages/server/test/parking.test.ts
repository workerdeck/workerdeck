import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  TOOL_RESULT_HEAD_CHARS,
  type JobEvent,
  type JobInfo,
  type ProfileInfo,
  type SessionEvent,
  type SessionInfo,
} from '@workerdeck/protocol'
import { createFileSessionStore, createWorkerServer, type SessionStore, type WorkerServer } from '../src/index.ts'
import { ParkableRunner } from './parkable-runner.ts'

function providerProfile(name = 'kimi'): ProfileInfo {
  return {
    name,
    engine: 'provider',
    provider: { id: 'moonshotai', model: 'kimi-k3' },
  }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

type Harness = {
  port: number
  runners: ParkableRunner[]
  base: string
}

async function startServer(options: Partial<Parameters<typeof createWorkerServer>[0]> = {}): Promise<Harness> {
  const runners: ParkableRunner[] = []
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [providerProfile(), providerProfile('other')],
    parking: { parkDelayMs: 10 },
    createEngineRunner: ({ config, restore }) => {
      const runner = new ParkableRunner(restore?.id ?? `session-${runners.length + 1}`, config, restore)
      runners.push(runner)
      return runner
    },
    ...options,
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return { port, runners, base: `http://127.0.0.1:${port}/v1` }
}

async function createSession(base: string, profile = 'kimi'): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile }),
  })
  return ((await res.json()) as { session: SessionInfo }).session
}

function submitResult(base: string, executionId: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}/executions/${executionId}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

describe('deferred execution: parking and result ingestion', () => {
  it('parks an unattended session and keeps it readable while its runner is gone', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => {
      expect((await running!.parking.get(session.id))?.kind).toBe('parked')
    })

    expect(running!.registry.get(session.id)).toBeUndefined()
    const read = (await fetch(`${h.base}/sessions/${session.id}`).then((r) => r.json())) as {
      session: SessionInfo
    }
    expect(read.session.status).toBe('parked')
    const listed = (await fetch(`${h.base}/sessions`).then((r) => r.json())) as {
      sessions: SessionInfo[]
    }
    expect(listed.sessions.map((s) => s.id)).toContain(session.id)
    const files = (await fetch(`${h.base}/sessions/${session.id}/files`).then((r) => r.json())) as {
      files: Array<{ path: string }>
    }
    expect(files.files.map((f) => f.path)).toEqual(['/out/report.md'])
    const download = await fetch(`${h.base}/sessions/${session.id}/files/out/report.md`)
    expect(await download.text()).toBe('# draft')
  })

  it('wakes the session under the same id and applies the result exactly once', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())

    const res = await submitResult(h.base, 'exec-1', {
      status: 'ok',
      output: { type: 'json', value: { answer: 42 } },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ applied: true, sessionId: session.id })

    expect(h.runners).toHaveLength(2)
    const resumed = h.runners[1]!
    expect(resumed.id).toBe(session.id)
    expect(running!.registry.get(session.id)).toBe(resumed)
    expect(resumed.settled).toEqual([{ executionId: 'exec-1', result: { status: 'ok', output: { answer: 42 }, logs: undefined } }])
    expect(await running!.parking.get(session.id)).toBeNull()

    const again = await submitResult(h.base, 'exec-1', {
      status: 'ok',
      output: { type: 'json', value: { answer: 42 } },
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ applied: false, sessionId: session.id })
    expect(resumed.settled).toHaveLength(1)
  })

  it('delivers a failed result as ordinary tool output', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())

    const res = await submitResult(h.base, 'exec-1', {
      status: 'failed',
      reason: 'worker_crashed',
      error: 'the worker died',
    })
    expect(res.status).toBe(200)
    expect(h.runners[1]!.settled[0]!.result).toMatchObject({
      status: 'failed',
      reason: 'worker_crashed',
    })
  })

  it('fails an execution whose result never arrives, waking the session to say so', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1', 'remote_task', Date.now() + 40)
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())

    await vi.waitFor(() => expect(h.runners).toHaveLength(2), { timeout: 2000 })
    expect(h.runners[1]!.settled[0]).toMatchObject({
      executionId: 'exec-1',
      result: { status: 'failed', reason: 'timeout' },
    })
  })

  it('rejects unknown ids and malformed bodies', async () => {
    const h = await startServer()
    expect((await submitResult(h.base, 'nope', { status: 'ok', output: { type: 'json', value: 1 } })).status).toBe(404)
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())
    expect((await submitResult(h.base, 'exec-1', { status: 'weird' })).status).toBe(400)
    expect((await submitResult(h.base, 'exec-1', { status: 'failed' })).status).toBe(400)
    expect((await fetch(`${h.base}/executions/exec-1/result`)).status).toBe(405)
  })

  it('scopes result delivery to the caller’s profiles', async () => {
    const runners: ParkableRunner[] = []
    running = createWorkerServer({
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile(), providerProfile('other')],
      parking: { parkDelayMs: 10 },
      authenticate: (req) => ({
        allowedProfiles: req.headers['x-profile'] === 'other' ? ['other'] : ['kimi'],
      }),
      createEngineRunner: ({ config, restore }) => {
        const runner = new ParkableRunner(restore?.id ?? `session-${runners.length + 1}`, config, restore)
        runners.push(runner)
        return runner
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const session = await createSession(base, 'kimi')
    runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())

    const refused = await submitResult(
      base,
      'exec-1',
      { status: 'ok', output: { type: 'json', value: 1 } },
      { headers: { 'content-type': 'application/json', 'x-profile': 'other' } },
    )
    expect(refused.status).toBe(404)
    expect(runners).toHaveLength(1)

    const allowed = await submitResult(base, 'exec-1', {
      status: 'ok',
      output: { type: 'json', value: 1 },
    })
    expect(allowed.status).toBe(200)
  })

  it('keeps a watched session live, and parks it when the last client leaves', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/v1/sessions/${session.id}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    h.runners[0]!.defer('exec-1')
    await new Promise((r) => setTimeout(r, 60))
    expect(running!.registry.get(session.id)).toBeDefined()
    expect(await running!.parking.get(session.id)).toBeNull()

    ws.close()
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())
  })

  it('rehydrates on attach, so a reconnect finds the session rather than a 404', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/v1/sessions/${session.id}/ws`)
    const attached = await new Promise<{ session: SessionInfo }>((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(String(data)) as { session: SessionInfo }))
      ws.on('error', reject)
    })
    expect(attached.session.id).toBe(session.id)
    expect(running!.registry.get(session.id)).toBeDefined()
    ws.close()
  })

  it('ends a parked session on DELETE, so a late result cannot wake it', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())

    const deleted = await fetch(`${h.base}/sessions/${session.id}`, { method: 'DELETE' })
    expect(((await deleted.json()) as { session: SessionInfo }).session.status).toBe('closed')
    expect(await running!.parking.get(session.id)).toBeNull()
    expect((await submitResult(h.base, 'exec-1', { status: 'ok', output: { type: 'json', value: 1 } })).status).toBe(404)
    expect(h.runners).toHaveLength(1)
  })

  it('serves a parked session’s whole tool result from its snapshot', async () => {
    const h = await startServer()
    const session = await createSession(h.base)
    const big = 'x'.repeat(TOOL_RESULT_HEAD_CHARS + 5_000)
    h.runners[0]!.toolResult('call-1', big)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => {
      expect((await running!.parking.get(session.id))?.kind).toBe('parked')
    })
    expect(running!.registry.get(session.id)).toBeUndefined()

    const record = (await running!.parking.get(session.id)) as {
      snapshot: { events: SessionEvent[] }
    }
    const seq = record.snapshot.events.find((event) => event.type === 'user_message' && Array.isArray(event.message.content))!.seq

    const res = await fetch(`${h.base}/sessions/${session.id}/events/${seq}/result?toolUseId=call-1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ seq, toolUseId: 'call-1', content: big, isError: false })

    expect((await fetch(`${h.base}/sessions/${session.id}/events/${seq}/result?toolUseId=other`)).status).toBe(404)
    expect((await fetch(`${h.base}/sessions/${session.id}/events/99999/result?toolUseId=call-1`)).status).toBe(404)
  })

  it('parks a queued job: the slot frees, and the result resumes and completes it', async () => {
    const jobEvents: JobEvent[] = []
    const h = await startServer({
      queue: { maxConcurrency: 1, onEvent: (event) => jobEvents.push(event) },
    })
    const submit = async (): Promise<JobInfo> => {
      const res = await fetch(`${h.base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: { cwd: '/tmp/project', profile: 'kimi', prompt: 'go' } }),
      })
      return ((await res.json()) as { job: JobInfo }).job
    }
    const first = await submit()
    const second = await submit()
    await vi.waitFor(() => expect(h.runners).toHaveLength(1))

    h.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => {
      const job = (await fetch(`${h.base}/jobs/${first.id}`).then((r) => r.json())) as { job: JobInfo }
      expect(job.job.status).toBe('parked')
      expect(job.job.parkedExecutionId).toBe('exec-1')
    })
    await vi.waitFor(() => expect(h.runners).toHaveLength(2))
    const stats = (await fetch(`${h.base}/queue`).then((r) => r.json())) as {
      stats: { running: number; parked: number }
    }
    expect(stats.stats).toMatchObject({ running: 1, parked: 1 })

    await submitResult(h.base, 'exec-1', { status: 'ok', output: { type: 'json', value: 7 } })
    const resumed = h.runners.at(-1)!
    resumed.finish()
    await vi.waitFor(async () => {
      const job = (await fetch(`${h.base}/jobs/${first.id}`).then((r) => r.json())) as { job: JobInfo }
      expect(job.job.status).toBe('succeeded')
    })
    expect(jobEvents.map((e) => e.type)).toContain('job_parked')
    expect(jobEvents.map((e) => e.type)).toContain('job_resumed')
    expect(second.id).not.toBe(first.id)
  })
})

// Two servers over one directory, sequentially — the only way a file store is ever legal.
describe('deferred execution: durability across a restart', () => {
  let dir: string
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const withStore = async (expiredGraceMs?: number): Promise<Harness> =>
    startServer({
      parking: { parkDelayMs: 10, expiredGraceMs, store: createFileSessionStore({ dir }) },
    })

  // Aged on the file rather than with a short timer, so the park itself cannot race the watchdog.
  const backdateDeadline = async (sessionId: string): Promise<void> => {
    const path = join(dir, `${sessionId}.json`)
    const file = JSON.parse(await readFile(path, 'utf8')) as {
      record: { executions: Array<{ expiresAt?: number }>; snapshot: { parked: Array<{ expiresAt?: number }> } }
    }
    const expiresAt = Date.now() - 1000
    for (const execution of file.record.executions) {
      execution.expiresAt = expiresAt
    }
    for (const execution of file.record.snapshot.parked) {
      execution.expiresAt = expiresAt
    }
    await writeFile(path, JSON.stringify(file))
  }

  it('hydrates a parked session from disk and wakes it under the same id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cw-parked-'))
    const first = await withStore()
    const session = await createSession(first.base)
    first.runners[0]!.defer('exec-1')
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())
    expect(await readdir(dir)).toEqual([`${session.id}.json`])

    await running!.close()
    const second = await withStore()

    expect(second.runners).toHaveLength(0)
    const listed = (await fetch(`${second.base}/sessions`).then((r) => r.json())) as {
      sessions: SessionInfo[]
    }
    expect(listed.sessions.map((s) => [s.id, s.status])).toEqual([[session.id, 'parked']])
    const download = await fetch(`${second.base}/sessions/${session.id}/files/out/report.md`)
    expect(await download.text()).toBe('# draft')

    const res = await submitResult(second.base, 'exec-1', {
      status: 'ok',
      output: { type: 'json', value: 42 },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ applied: true, sessionId: session.id })
    const resumed = second.runners[0]!
    expect(resumed.id).toBe(session.id)
    expect(resumed.settled).toEqual([{ executionId: 'exec-1', result: { status: 'ok', output: 42, logs: undefined } }])
    expect(resumed.info().lastSeq).toBeGreaterThan(2)
    expect(await running!.parking.get(session.id)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  // A store whose `save` takes real time: the park evicts before the write lands, opening the window these tests aim at.
  const slowSaveStore = (delayMs: number): SessionStore => {
    const inner = createFileSessionStore({ dir })
    return {
      ...inner,
      save: async (record) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        await inner.save(record)
      },
    }
  }

  it('applies a result that lands while the park is still being written', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cw-parked-'))
    const h = await startServer({ parking: { parkDelayMs: 10, store: slowSaveStore(80) } })
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(() => expect(running!.registry.get(session.id)).toBeUndefined())

    const res = await submitResult(h.base, 'exec-1', {
      status: 'ok',
      output: { type: 'json', value: 42 },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ applied: true, sessionId: session.id })
    expect(h.runners[1]!.settled).toHaveLength(1)
    expect(await running!.parking.get(session.id)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps a session deleted during the save window deleted', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cw-parked-'))
    const h = await startServer({ parking: { parkDelayMs: 10, store: slowSaveStore(80) } })
    const session = await createSession(h.base)
    h.runners[0]!.defer('exec-1')
    await vi.waitFor(() => expect(running!.registry.get(session.id)).toBeUndefined())

    const deleted = await fetch(`${h.base}/sessions/${session.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await readdir(dir)).toEqual([])
    const listed = (await fetch(`${h.base}/sessions`).then((r) => r.json())) as {
      sessions: SessionInfo[]
    }
    expect(listed.sessions).toEqual([])
    expect((await submitResult(h.base, 'exec-1', { status: 'ok', output: { type: 'json', value: 1 } })).status).toBe(404)
  })

  it('gives an execution whose deadline passed during the outage a grace window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cw-parked-'))
    const first = await withStore()
    const session = await createSession(first.base)
    first.runners[0]!.defer('exec-1', 'remote_task', Date.now() + 5_000)
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())
    await running!.close()
    await backdateDeadline(session.id)

    const second = await withStore(10_000)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(second.runners).toHaveLength(0)

    expect((await submitResult(second.base, 'exec-1', { status: 'ok', output: { type: 'json', value: 1 } })).status).toBe(200)
    expect(second.runners[0]!.settled[0]).toMatchObject({ result: { status: 'ok' } })
  })

  it('still fails an expired execution once the grace window is over', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cw-parked-'))
    const first = await withStore()
    const session = await createSession(first.base)
    first.runners[0]!.defer('exec-1', 'remote_task', Date.now() + 5_000)
    await vi.waitFor(async () => expect(await running!.parking.get(session.id)).not.toBeNull())
    await running!.close()
    await backdateDeadline(session.id)

    const second = await withStore(0)
    await vi.waitFor(() => expect(second.runners).toHaveLength(1), { timeout: 2000 })
    expect(second.runners[0]!.settled[0]).toMatchObject({
      executionId: 'exec-1',
      result: { status: 'failed', reason: 'timeout' },
    })
  })
})
