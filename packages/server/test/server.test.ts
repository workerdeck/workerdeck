import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { JobEvent, JobInfo, ProfileInfo, QueueServerFrame, QueueStats, SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { fakeHarness, frameCollector, listenOn } from './helpers.ts'

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: ['Bash'],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function startServer(harness: ReturnType<typeof fakeHarness>) {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  return listenOn(running)
}

describe('createWorkerServer', () => {
  it('requires an auth decision at construction', () => {
    expect(() => createWorkerServer()).toThrow(/authenticate/)
  })

  describe('the fallback option', () => {
    it('receives everything outside basePath and nothing inside it', async () => {
      const seen: string[] = []
      running = createWorkerServer({
        allowUnauthenticated: true,
        fallback: (req, res) => {
          seen.push(req.url ?? '')
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('from the host')
        },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}`

      expect(await (await fetch(`${base}/`)).text()).toBe('from the host')
      expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe('from the host')
      expect((await fetch(`${base}/v1/nope`)).status).toBe(404)
      expect(await (await fetch(`${base}/v1/nope`)).json()).toEqual({ error: 'not found' })

      expect(seen).toEqual(['/', '/assets/app.js'])
    })

    it('does not shadow a route that merely starts with the basePath string', async () => {
      running = createWorkerServer({
        allowUnauthenticated: true,
        fallback: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('host')
        },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const res = await fetch(`http://127.0.0.1:${port}/v1x`)
      expect(await res.text()).toBe('host')
    })

    it('still refuses an upgrade outside basePath', async () => {
      running = createWorkerServer({
        allowUnauthenticated: true,
        fallback: (_req, res) => {
          res.writeHead(200)
          res.end()
        },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`)
      await new Promise<void>((resolve, reject) => {
        ws.on('error', () => resolve())
        ws.on('close', () => resolve())
        ws.on('open', () => reject(new Error('upgrade should not have been accepted')))
      })
    })
  })

  it('runs the full session lifecycle over REST + WS', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness)

    const createRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', prompt: 'hello' }),
    })
    expect(createRes.status).toBe(201)
    const { session } = (await createRes.json()) as { session: SessionInfo }
    expect(session.status).toBe('starting')

    const listRes = await fetch(`${base}/sessions`)
    const listBody = (await listRes.json()) as { sessions: SessionInfo[] }
    expect(listBody.sessions.map((s) => s.id)).toContain(session.id)

    const ws = new WebSocket(`${wsBase}/sessions/${session.id}/ws`)
    const collector = frameCollector(ws)
    await collector.waitFor((f) => f.type === 'attached')

    harness.emit(initMessage)
    await collector.waitFor((f) => f.type === 'event' && f.event.type === 'system_init')

    ws.send(JSON.stringify({ type: 'user_message', text: 'follow-up' }))
    await vi.waitFor(() => {
      expect(harness.captured.inputs.map((m) => m.message.content)).toContain('follow-up')
    })

    ws.send(JSON.stringify({ type: 'set_model', model: 'claude-opus-4-8' }))
    await collector.waitFor((f) => f.type === 'event' && f.event.type === 'model_changed' && f.event.model === 'claude-opus-4-8')
    expect(harness.setModel).toHaveBeenCalledWith('claude-opus-4-8')

    const resultPromise = harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-1' },
    )
    const requested = await collector.waitFor((f) => f.type === 'event' && f.event.type === 'permission_requested')
    const requestId = requested.type === 'event' && requested.event.type === 'permission_requested' ? requested.event.request.id : ''
    ws.send(JSON.stringify({ type: 'permission_decision', requestId, behavior: 'allow' }))
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'allow' })
    await collector.waitFor((f) => f.type === 'event' && f.event.type === 'permission_resolved')

    const lastSeqRes = await fetch(`${base}/sessions/${session.id}`)
    const { session: current } = (await lastSeqRes.json()) as { session: SessionInfo }
    ws.close()
    const ws2 = new WebSocket(`${wsBase}/sessions/${session.id}/ws?afterSeq=${current.lastSeq - 1}`)
    const collector2 = frameCollector(ws2)
    await collector2.waitFor((f) => f.type === 'attached')
    const replayed = await collector2.waitFor((f) => f.type === 'event')
    expect(replayed.type === 'event' && replayed.event.seq).toBe(current.lastSeq)
    ws2.close()

    const delRes = await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    const gone = await fetch(`${base}/sessions/${session.id}`)
    expect(gone.status).toBe(404)
  })

  it('renames a session over PATCH, and clears back to the derived title', async () => {
    const harness = fakeHarness()
    const { base } = await startServer(harness)

    const createRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', prompt: 'ship the thing' }),
    })
    const { session } = (await createRes.json()) as { session: SessionInfo }
    expect(session.title).toBe('ship the thing')

    const patch = async (body: unknown) =>
      fetch(`${base}/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const named = await patch({ title: '  Release prep  ' })
    expect(named.status).toBe(200)
    expect(((await named.json()) as { session: SessionInfo }).session.title).toBe('Release prep')

    const listed = (await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }
    expect(listed.sessions.find((s) => s.id === session.id)?.title).toBe('Release prep')

    const cleared = await patch({ title: null })
    expect(((await cleared.json()) as { session: SessionInfo }).session.title).toBe('ship the thing')

    expect((await patch({ title: 42 })).status).toBe(400)
    const unknown = await fetch(`${base}/sessions/nope`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(unknown.status).toBe(404)
  })

  it('resolves a pending permission over REST (remote-controller channel)', async () => {
    const harness = fakeHarness()
    const { base } = await startServer(harness)

    const createRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', prompt: 'hello' }),
    })
    const { session } = (await createRes.json()) as { session: SessionInfo }
    harness.emit(initMessage)

    const input = {
      questions: [
        {
          question: 'Proceed?',
          header: 'Plan',
          multiSelect: false,
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        },
      ],
    }
    const resultPromise = harness.captured.options!.canUseTool!('AskUserQuestion', input, {
      signal: new AbortController().signal,
      requestId: 'creq-1',
      toolUseID: 'q-1',
    })
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/sessions/${session.id}`)
      const body = (await res.json()) as { session: SessionInfo }
      expect(body.session.pendingPermissionCount).toBe(1)
    })

    const bogus = await fetch(`${base}/sessions/${session.id}/permissions/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'allow' }),
    })
    expect(bogus.status).toBe(404)

    const requestId = running!.registry.get(session.id)!.pendingApprovals[0]!.id
    const answers = { 'Proceed?': 'Yes' }
    const resolveRes = await fetch(`${base}/sessions/${session.id}/permissions/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'allow', updatedInput: { ...input, answers } }),
    })
    expect(resolveRes.status).toBe(200)
    expect(await resolveRes.json()).toEqual({ resolved: true })
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers },
      toolUseID: 'q-1',
    })

    const again = await fetch(`${base}/sessions/${session.id}/permissions/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'deny' }),
    })
    expect(again.status).toBe(404)
  })

  it('fails closed on subscription credentials when requireApiKey is set', async () => {
    const harness = fakeHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      requireApiKey: true,
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const createRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project' }),
    })
    const { session } = (await createRes.json()) as { session: SessionInfo }

    harness.emit({ ...(initMessage as object), apiKeySource: 'oauth' } as typeof initMessage)
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/sessions/${session.id}`)
      const body = (await res.json()) as { session: SessionInfo }
      expect(body.session.status).toBe('failed')
    })
  })

  it('enforces cwd roots and auth', async () => {
    const harness = fakeHarness()
    const { base } = await startServer(harness)
    const outside = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/etc' }),
    })
    expect(outside.status).toBe(403)
    await running!.close()

    running = createWorkerServer({
      authenticate: (req) => (req.headers.authorization === 'Bearer secret' ? { ok: true } : null),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const authBase = `http://127.0.0.1:${port}/v1`
    expect((await fetch(`${authBase}/sessions`)).status).toBe(401)
    expect(
      (
        await fetch(`${authBase}/sessions`, {
          headers: { authorization: 'Bearer secret' },
        })
      ).status,
    ).toBe(200)
  })

  it('returns 404 for job routes when the queue is not configured', async () => {
    const harness = fakeHarness()
    const { base } = await startServer(harness)
    expect((await fetch(`${base}/jobs`)).status).toBe(404)
    expect((await fetch(`${base}/queue`)).status).toBe(404)
  })

  it('runs a job end-to-end: schedule, watch, webhook deliveries, completion', async () => {
    const harness = fakeHarness()
    const deliveries: JobEvent[] = []
    const receiver: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        deliveries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JobEvent)
        res.writeHead(200).end()
      })
    })
    const receiverPort = await new Promise<number>((resolve) => {
      receiver.listen(0, '127.0.0.1', () => {
        const address = receiver.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        queue: { maxConcurrency: 1, dailyTokenLimit: 10_000 },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      const outside = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: { cwd: '/etc', prompt: 'x' } }),
      })
      expect(outside.status).toBe(403)

      const createRes = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: { cwd: '/tmp/project', prompt: 'summarize the repo' },
          webhook: { url: `http://127.0.0.1:${receiverPort}/hook` },
          meta: { source: 'test' },
        }),
      })
      expect(createRes.status).toBe(201)
      const { job } = (await createRes.json()) as { job: JobInfo }
      expect(job.status).toBe('queued')

      await vi.waitFor(async () => {
        const res = await fetch(`${base}/jobs/${job.id}`)
        const body = (await res.json()) as { job: JobInfo }
        expect(body.job.status).toBe('running')
        expect(body.job.sessionId).toBeDefined()
      })
      const runningJob = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as { job: JobInfo }).job
      expect((await fetch(`${base}/sessions/${runningJob.sessionId}`)).status).toBe(200)
      expect(harness.captured.inputs.map((m) => m.message.content)).toContain('summarize the repo')

      harness.emit(initMessage)
      harness.emit({
        type: 'result',
        subtype: 'success',
        duration_ms: 500,
        duration_api_ms: 400,
        is_error: false,
        num_turns: 1,
        result: 'repo summarized',
        stop_reason: 'end_turn',
        total_cost_usd: 0.03,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: {},
        permission_denials: [],
        uuid: 'uuid-r1',
        session_id: 'sdk-1',
      } as unknown as SDKMessage)

      await vi.waitFor(async () => {
        const res = await fetch(`${base}/jobs/${job.id}`)
        const body = (await res.json()) as { job: JobInfo }
        expect(body.job.status).toBe('succeeded')
      })
      const done = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as { job: JobInfo }).job
      expect(done).toMatchObject({
        result: { subtype: 'success', result: 'repo summarized' },
        usage: { tokens: 150, totalCostUsd: 0.03, numTurns: 1 },
        sdkSessionId: 'sdk-1',
        meta: { source: 'test' },
      })

      await vi.waitFor(() => {
        expect(deliveries.map((e) => e.type)).toEqual(['job_started', 'job_completed'])
      })
      expect(deliveries[1]!.job.status).toBe('succeeded')

      const stats = ((await (await fetch(`${base}/queue`)).json()) as { stats: QueueStats }).stats
      expect(stats).toMatchObject({
        maxConcurrency: 1,
        running: 0,
        queued: 0,
        dailyTokensUsed: 150,
        dailyTokenLimit: 10_000,
        paused: false,
      })

      const listBody = (await (await fetch(`${base}/jobs`)).json()) as { jobs: JobInfo[] }
      expect(listBody.jobs.map((j) => j.id)).toContain(job.id)
      expect((await fetch(`${base}/jobs/unknown`, { method: 'DELETE' })).status).toBe(404)
    } finally {
      await new Promise((resolve) => receiver.close(resolve))
    }
  })

  it('streams job lifecycle and stats over the queue WS', async () => {
    const harness = fakeHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
      queue: { maxConcurrency: 1 },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/queue/ws`)
    const frames: QueueServerFrame[] = []
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as QueueServerFrame))
    await vi.waitFor(() => {
      expect(frames.some((f) => f.type === 'queue_attached')).toBe(true)
    })
    const attached = frames.find((f) => f.type === 'queue_attached')
    expect(attached?.type === 'queue_attached' && attached.stats.maxConcurrency).toBe(1)

    const createRes = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: { cwd: '/tmp/project', prompt: 'go' } }),
    })
    const { job } = (await createRes.json()) as { job: JobInfo }

    const eventTypes = () => frames.filter((f) => f.type === 'job_event').map((f) => (f as { event: JobEvent }).event.type)
    await vi.waitFor(() => {
      expect(eventTypes()).toContain('job_submitted')
      expect(eventTypes()).toContain('job_started')
    })

    harness.emit(initMessage)
    harness.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0.03,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
      permission_denials: [],
      uuid: 'uuid-r1',
      session_id: 'sdk-1',
    } as unknown as SDKMessage)

    await vi.waitFor(() => {
      const completed = frames.find((f) => f.type === 'job_event' && f.event.type === 'job_completed' && f.event.job.id === job.id)
      expect(completed).toBeDefined()
    })
    await vi.waitFor(() => {
      const stats = frames.filter((f) => f.type === 'queue_stats')
      expect(stats.length).toBeGreaterThan(0)
    })
    ws.close()
  })

  it('lists SDK on-disk sessions via GET /sdk-sessions', async () => {
    const inProject = {
      sessionId: 'sdk-1',
      summary: 'earlier session',
      lastModified: 1000,
      cwd: '/tmp/project',
    }
    // Stands in for the SDK: a bare call spans the whole host, including a project outside the roots and one with no cwd.
    const lister = vi.fn(async (options: { dir?: string; limit?: number; offset?: number }) =>
      options.dir
        ? [inProject]
        : [
            inProject,
            { sessionId: 'sdk-elsewhere', summary: 'other', lastModified: 2000, cwd: '/etc/x' },
            { sessionId: 'sdk-unknown', summary: 'no cwd', lastModified: 3000 },
          ],
    )
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp', '/var'],
      listSdkSessions: lister,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    expect((await fetch(`${base}/sdk-sessions?dir=/etc`)).status).toBe(403)

    const all = await fetch(`${base}/sdk-sessions`)
    expect(all.status).toBe(200)
    const listed = (await all.json()) as { sdkSessions: Array<{ sessionId: string }> }
    expect(listed.sdkSessions.map((s) => s.sessionId)).toEqual(['sdk-1'])
    expect(lister).toHaveBeenCalledWith({})
    lister.mockClear()

    const res = await fetch(`${base}/sdk-sessions?dir=/tmp/project&limit=10`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sdkSessions: Array<{ sessionId: string }> }
    expect(body.sdkSessions.map((s) => s.sessionId)).toEqual(['sdk-1'])
    expect(lister).toHaveBeenCalledWith({ dir: '/tmp/project', limit: 10, offset: undefined })

    expect((await fetch(`${base}/sdk-sessions`, { method: 'POST' })).status).toBe(405)
  })

  it('declares profiles: lists them, requires a choice, applies defaults, pins CLAUDE_CONFIG_DIR', async () => {
    const harness = fakeHarness()
    const tobyDir = mkdtempSync(join(tmpdir(), 'cw-profile-toby-'))
    const danDir = mkdtempSync(join(tmpdir(), 'cw-profile-dan-'))
    try {
      expect(() =>
        createWorkerServer({
          allowUnauthenticated: true,
          profiles: [{ name: 'ghost', configDir: join(tmpdir(), 'cw-does-not-exist') }],
        }),
      ).toThrow(/configDir/)

      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        profiles: [
          { name: 'toby', configDir: tobyDir, defaults: { model: 'opus', permissionMode: 'acceptEdits' } },
          { name: 'dan', configDir: danDir },
        ],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      const listBody = (await (await fetch(`${base}/profiles`)).json()) as { profiles: ProfileInfo[] }
      expect(listBody.profiles.map((p) => p.name)).toEqual(['toby', 'dan'])

      const missing = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project' }),
      })
      expect(missing.status).toBe(400)
      expect(((await missing.json()) as { error: string }).error).toMatch(/profile is required/)

      const unknown = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project', profile: 'mark' }),
      })
      expect(unknown.status).toBe(400)
      expect(((await unknown.json()) as { error: string }).error).toMatch(/unknown profile/)

      const createRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project', prompt: 'hello', profile: 'toby' }),
      })
      expect(createRes.status).toBe(201)
      const { session } = (await createRes.json()) as { session: SessionInfo }
      expect(session.profile).toBe('toby')
      await vi.waitFor(() => {
        expect(harness.captured.options?.env?.CLAUDE_CONFIG_DIR).toBe(tobyDir)
      })
      expect(harness.captured.options?.model).toBe('opus')
      expect(harness.captured.options?.permissionMode).toBe('acceptEdits')

      await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project', prompt: 'hi', profile: 'toby', model: 'sonnet' }),
      })
      await vi.waitFor(() => {
        expect(harness.captured.options?.model).toBe('sonnet')
      })

      await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cwd: '/tmp/project',
          prompt: 'hi',
          profile: 'dan',
          allowDangerouslySkipPermissions: true,
        }),
      })
      await vi.waitFor(() => {
        expect(harness.captured.options?.allowDangerouslySkipPermissions).toBe(true)
      })
    } finally {
      rmSync(tobyDir, { recursive: true, force: true })
      rmSync(danDir, { recursive: true, force: true })
    }
  })

  it('scopes profiles to the principal via allowedProfiles', async () => {
    const harness = fakeHarness()
    const tobyDir = mkdtempSync(join(tmpdir(), 'cw-profile-toby-'))
    const danDir = mkdtempSync(join(tmpdir(), 'cw-profile-dan-'))
    try {
      running = createWorkerServer({
        authenticate: (req) =>
          req.headers.authorization === 'Bearer dan'
            ? { allowedProfiles: ['dan'] }
            : req.headers.authorization === 'Bearer admin'
              ? { admin: true }
              : null,
        allowedCwdRoots: ['/tmp'],
        profiles: [
          { name: 'toby', configDir: tobyDir },
          { name: 'dan', configDir: danDir },
        ],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`
      const asDan = { 'content-type': 'application/json', authorization: 'Bearer dan' }

      const danList = (await (await fetch(`${base}/profiles`, { headers: { authorization: 'Bearer dan' } })).json()) as {
        profiles: ProfileInfo[]
      }
      expect(danList.profiles.map((p) => p.name)).toEqual(['dan'])
      const adminList = (await (await fetch(`${base}/profiles`, { headers: { authorization: 'Bearer admin' } })).json()) as {
        profiles: ProfileInfo[]
      }
      expect(adminList.profiles.map((p) => p.name)).toEqual(['toby', 'dan'])

      const forbidden = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: asDan,
        body: JSON.stringify({ cwd: '/tmp/project', profile: 'toby' }),
      })
      expect(forbidden.status).toBe(403)

      const allowed = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: asDan,
        body: JSON.stringify({ cwd: '/tmp/project', profile: 'dan' }),
      })
      expect(allowed.status).toBe(201)
      expect(((await allowed.json()) as { session: SessionInfo }).session.profile).toBe('dan')

      expect((await fetch(`${base}/profiles/toby`, { headers: { authorization: 'Bearer dan' } })).status).toBe(403)
      expect((await fetch(`${base}/profiles/dan`, { headers: { authorization: 'Bearer dan' } })).status).toBe(200)
    } finally {
      rmSync(tobyDir, { recursive: true, force: true })
      rmSync(danDir, { recursive: true, force: true })
    }
  })

  it('enforces disableBypassPermissions: rejects the mode, strips the capability', async () => {
    const harness = fakeHarness()
    const profileDir = mkdtempSync(join(tmpdir(), 'cw-bypass-'))
    try {
      expect(() =>
        createWorkerServer({
          allowUnauthenticated: true,
          disableBypassPermissions: true,
          profiles: [{ name: 'yolo', configDir: profileDir, defaults: { permissionMode: 'bypassPermissions' } }],
        }),
      ).toThrow(/disableBypassPermissions/)

      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        disableBypassPermissions: true,
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        queue: { maxConcurrency: 1 },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      const sessionRes = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project', permissionMode: 'bypassPermissions' }),
      })
      expect(sessionRes.status).toBe(403)
      const jobRes = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: { cwd: '/tmp/project', prompt: 'x', permissionMode: 'bypassPermissions' },
        }),
      })
      expect(jobRes.status).toBe(403)

      const stripped = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cwd: '/tmp/project',
          prompt: 'hi',
          allowDangerouslySkipPermissions: true,
        }),
      })
      expect(stripped.status).toBe(201)
      await vi.waitFor(() => {
        expect(harness.captured.options).toBeDefined()
      })
      expect(harness.captured.options?.allowDangerouslySkipPermissions).toBeUndefined()
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('passes allowDangerouslySkipPermissions through to job sessions when requested', async () => {
    const harness = fakeHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
      queue: { maxConcurrency: 1 },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session: { cwd: '/tmp/project', prompt: 'go', allowDangerouslySkipPermissions: true },
      }),
    })
    expect(res.status).toBe(201)
    await vi.waitFor(() => {
      expect(harness.captured.options?.allowDangerouslySkipPermissions).toBe(true)
    })
  })

  it('serves the static catalog and capability record from the first request (cold start)', async () => {
    const harness = fakeHarness([
      { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    ])
    const dir = mkdtempSync(join(tmpdir(), 'cw-profile-models-'))
    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        profiles: [{ name: 'main', configDir: dir }],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      const before = (await (await fetch(`${base}/profiles`)).json()) as { profiles: ProfileInfo[] }
      expect(before.profiles[0]!.models?.length).toBeGreaterThan(0)
      expect(before.profiles[0]!.models?.some((m) => m.value === 'default')).toBe(false)
      expect(before.profiles[0]!.capabilities?.interactiveApprovals).toBe(true)
      expect(before.profiles[0]!.defaultModel).toBeUndefined()

      await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project', profile: 'main' }),
      })

      await vi.waitFor(async () => {
        const after = (await (await fetch(`${base}/profiles`)).json()) as { profiles: ProfileInfo[] }
        expect(after.profiles[0]!.defaultModel).toBe('claude-opus-5[1m]')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves a curated config snapshot on GET /profiles/:name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-profile-snap-'))
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          model: 'opus',
          permissions: { defaultMode: 'acceptEdits', allow: ['Bash(ls:*)', 'Read'], deny: ['WebFetch'] },
          env: { MY_TOKEN: 'secret-value', FOO: 'bar' },
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] },
        }),
      )
      writeFileSync(join(dir, 'CLAUDE.md'), '# memory')
      mkdirSync(join(dir, 'skills', 'review'), { recursive: true })
      mkdirSync(join(dir, 'agents'), { recursive: true })
      writeFileSync(join(dir, 'agents', 'helper.md'), '---\n---')
      mkdirSync(join(dir, 'commands'), { recursive: true })
      writeFileSync(join(dir, 'commands', 'deploy.md'), 'deploy')

      running = createWorkerServer({
        allowUnauthenticated: true,
        profiles: [{ name: 'main', configDir: dir }],
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      expect((await fetch(`${base}/profiles/nope`)).status).toBe(404)

      const res = await fetch(`${base}/profiles/main`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        profile: ProfileInfo
        config: {
          settings?: Record<string, unknown>
          hasUserMemory: boolean
          skills: string[]
          agents: string[]
          commands: string[]
        }
      }
      expect(body.profile.name).toBe('main')
      expect(body.config).toMatchObject({
        hasUserMemory: true,
        skills: ['review'],
        agents: ['helper'],
        commands: ['deploy'],
        settings: {
          model: 'opus',
          defaultPermissionMode: 'acceptEdits',
          permissionRules: { allow: 2, ask: 0, deny: 1 },
          envKeys: ['FOO', 'MY_TOKEN'],
          hooks: ['PreToolUse'],
        },
      })
      expect(JSON.stringify(body)).not.toContain('secret-value')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats an only profile as implicit and carries it through jobs', async () => {
    const harness = fakeHarness()
    const mainDir = mkdtempSync(join(tmpdir(), 'cw-profile-main-'))
    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        profiles: [{ name: 'main', configDir: mainDir }],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        queue: { maxConcurrency: 1 },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      const createRes = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: { cwd: '/tmp/project', prompt: 'go' } }),
      })
      expect(createRes.status).toBe(201)
      const { job } = (await createRes.json()) as { job: JobInfo }
      expect(job.profile).toBe('main')

      await vi.waitFor(async () => {
        const res = await fetch(`${base}/jobs/${job.id}`)
        const body = (await res.json()) as { job: JobInfo }
        expect(body.job.sessionId).toBeDefined()
      })
      await vi.waitFor(() => {
        expect(harness.captured.options?.env?.CLAUDE_CONFIG_DIR).toBe(mainDir)
      })

      const jobNow = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as { job: JobInfo }).job
      const sessionRes = await fetch(`${base}/sessions/${jobNow.sessionId}`)
      expect(((await sessionRes.json()) as { session: SessionInfo }).session.profile).toBe('main')
    } finally {
      rmSync(mainDir, { recursive: true, force: true })
    }
  })
})

describe('shutdown', () => {
  it('closes while a session socket is still attached', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness)

    const ws = await attachSessionSocket(base, wsBase)

    // `wss` is `noServer`, so nothing in the close path used to reach an upgraded session socket and
    // `server.close()`'s callback never fired: any attached dashboard tab hung Ctrl+C forever.
    const server = running!
    running = undefined
    await expect(withTimeout(server.close(), 2000)).resolves.toBeUndefined()
    expect(ws.readyState).not.toBe(WebSocket.OPEN)
  })

  it('is idempotent, so a second signal does not hang or throw', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness)
    const ws = await attachSessionSocket(base, wsBase)

    const server = running!
    running = undefined
    const first = server.close()
    const second = server.close()
    await expect(withTimeout(Promise.all([first, second]), 2000)).resolves.toBeDefined()
    await expect(withTimeout(server.close(), 2000)).resolves.toBeUndefined()
  })
})

/** A session with a live, fully attached client socket — the shape that used to hang `close()`. */
async function attachSessionSocket(base: string, wsBase: string): Promise<WebSocket> {
  const createRes = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', prompt: 'hello' }),
  })
  const { session } = (await createRes.json()) as { session: SessionInfo }
  const ws = new WebSocket(`${wsBase}/sessions/${session.id}/ws`)
  await frameCollector(ws).waitFor((f) => f.type === 'attached')
  return ws
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      timer.unref()
    }),
  ])
}
