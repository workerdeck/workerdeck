import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createVfs } from '@workerdeck/sandbox'
import type { Runner, SessionRunnerConfig, ToolExecutionResult } from '@workerdeck/core'
import type { ProfileInfo, SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type EngineRunnerContext, type WorkerServer } from '../src/index.ts'

/** Minimal Runner implementation — engine selection is what's under test, not the engine. */
function fakeRunner(id: string, config: SessionRunnerConfig): Runner {
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
    }),
    subscribe: () => () => {},
    sendMessage: () => {},
    setTitle: () => {},
    resolvePermission: () => false,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    fail: () => {},
    close: () => {},
  }
}

let running: WorkerServer | undefined
let configDir: string | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
  if (configDir) {
    rmSync(configDir, { recursive: true, force: true })
  }
  configDir = undefined
})

const claudeProfile = (): ProfileInfo => {
  configDir = mkdtempSync(join(tmpdir(), 'cw-profile-'))
  return { name: 'claude', configDir }
}

const providerProfile = (): ProfileInfo => ({
  name: 'kimi',
  engine: 'provider',
  provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
  defaults: { model: 'kimi-k3' },
})

describe('provider profiles and engine selection', () => {
  it('refuses to start when a provider profile has no engine factory', () => {
    expect(() => createWorkerServer({ allowUnauthenticated: true, profiles: [providerProfile()] })).toThrow(/no `createEngineRunner`/)
  })

  it('refuses a provider profile without a provider id', () => {
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [{ name: 'broken', engine: 'provider' }],
        createEngineRunner: ({ config }) => fakeRunner('x', config),
      }),
    ).toThrow(/missing provider\.id/)
  })

  it('still requires a real config dir for claude profiles', () => {
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [{ name: 'nope', configDir: '/definitely/not/here' }],
      }),
    ).toThrow(/configDir does not exist/)
  })

  it('builds the engine runner for a provider profile and skips CLAUDE_CONFIG_DIR', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [claudeProfile(), providerProfile()],
      createEngineRunner,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    expect(res.status).toBe(201)

    expect(createEngineRunner).toHaveBeenCalledOnce()
    const ctx = createEngineRunner.mock.calls[0]![0]
    expect(ctx.profile.name).toBe('kimi')
    // Profile defaults fill unset request fields...
    expect(ctx.config.model).toBe('kimi-k3')
    // ...but no config dir is pinned: credentials come from the environment.
    expect(ctx.config.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    // The bridge is handed over so the engine can execute tools in the tab.
    expect(typeof ctx.bridge.executorFor).toBe('function')
  })

  it('routes claude profiles to the SDK runner, untouched', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    const profile = claudeProfile()
    const configs: SessionRunnerConfig[] = []
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [profile, providerProfile()],
      createEngineRunner,
      buildRunnerConfig: (req) => {
        const config = { ...req, queryFn: (() => idleQuery()) as never }
        configs.push(config)
        return config
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'claude' }),
    })
    expect(res.status).toBe(201)
    expect(createEngineRunner).not.toHaveBeenCalled()
  })

  it("feeds bridged execution results back into the runner's settleExecution", async () => {
    const settled: Array<{ executionId: string; result: ToolExecutionResult }> = []
    const hostResults: string[] = []
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      bridge: { onResult: (_s, executionId) => hostResults.push(executionId) },
      createEngineRunner: ({ config }) => ({
        ...fakeRunner('engine-1', config),
        settleExecution: (executionId, result) => {
          settled.push({ executionId, result })
          return true
        },
      }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    const { session } = (await res.json()) as { session: SessionInfo }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${session.id}/ws`)
    const attached = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        if ((JSON.parse(String(data)) as { type: string }).type === 'attached') {
          resolve()
        }
      })
    })
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type: string; executionId?: string }
      if (frame.type === 'tool_call_request') {
        ws.send(
          JSON.stringify({
            type: 'tool_call_result',
            executionId: frame.executionId,
            output: { type: 'json', value: 42 },
          }),
        )
      }
    })
    await attached

    const pending = await running.bridge.executorFor(session.id).dispatch({
      executionId: 'exec-1',
      sessionId: session.id,
      tool: 'eval_script',
      input: { script: '6 * 7' },
    })
    expect(pending.status).toBe('pending')

    // The server wires the answer into the runner itself — no host boilerplate —
    // and the host's own onResult observer still fires.
    await vi.waitFor(() => expect(settled).toHaveLength(1))
    expect(settled[0]).toMatchObject({
      executionId: 'exec-1',
      result: { status: 'ok', output: 42 },
    })
    expect(hostResults).toEqual(['exec-1'])
    ws.close()
  })

  it('serves session files straight from the runner VFS', async () => {
    const vfs = createVfs({
      '/out/report.json': '{"revenuePerEmployee":348}',
      '/SUMMARY.md': '# Summary\n',
    })
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => ({ ...fakeRunner('engine-1', config), vfs }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    const { session } = (await created.json()) as { session: SessionInfo }
    const base = `http://127.0.0.1:${port}/v1/sessions/${session.id}/files`

    const list = await fetch(base)
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({
      files: [
        { path: '/SUMMARY.md', bytes: 10 },
        { path: '/out/report.json', bytes: 26 },
      ],
    })

    const download = await fetch(`${base}/out/report.json`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('application/json')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(download.headers.get('content-disposition')).toContain('report.json')
    expect(await download.text()).toBe('{"revenuePerEmployee":348}')

    expect((await fetch(`${base}/nope.txt`)).status).toBe(404)
  })

  it('404s the file routes for engines without a VFS', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    const { session } = (await created.json()) as { session: SessionInfo }
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/files`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'session has no file store' })
  })

  it('serves provider profiles over the profiles API without a config snapshot', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/profiles/kimi`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { profile: ProfileInfo; config: { skills: string[] } }
    expect(body.profile).toMatchObject({
      name: 'kimi',
      engine: 'provider',
      provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
    })
    // Names only, never values — the key itself is never on the wire.
    expect(JSON.stringify(body.profile)).not.toContain('sk-')
    expect(body.config.skills).toEqual([])
  })

  it('awaits an async engine factory before answering the create', async () => {
    let assembled = false
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      // The shape a per-session MCP connect needs: assembly that resolves later.
      createEngineRunner: async ({ config }) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        assembled = true
        return fakeRunner('engine-async', config)
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    expect(res.status).toBe(201)
    expect(assembled).toBe(true)
    // Adopted into the registry, so it is attachable like any other session.
    expect(((await res.json()) as { session: SessionInfo }).session.id).toBe('engine-async')
    const listed = (await fetch(`http://127.0.0.1:${port}/v1/sessions`).then((r) => r.json())) as {
      sessions: SessionInfo[]
    }
    expect(listed.sessions).toHaveLength(1)
  })

  it('fails the create when async engine assembly rejects', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: () => Promise.reject(new Error('MCP server unreachable')),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toBe('MCP server unreachable')
    // Nothing half-registered: a failed assembly leaves no session behind.
    const listed = (await fetch(`http://127.0.0.1:${port}/v1/sessions`).then((r) => r.json())) as {
      sessions: SessionInfo[]
    }
    expect(listed.sessions).toEqual([])
  })

  it('rejects a CLI-only permission mode on a provider profile', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi', permissionMode: 'plan' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/'plan' is not supported by profile 'kimi'/)
    // Refused at the gateway — the engine is never asked to make sense of it.
    expect(createEngineRunner).not.toHaveBeenCalled()
  })

  it('accepts the modes the provider engine does run', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    for (const permissionMode of ['default', 'dontAsk', 'bypassPermissions']) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi', permissionMode }),
      })
      expect(res.status, permissionMode).toBe(201)
    }
  })

  it('leaves the full mode vocabulary alone for claude profiles', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [claudeProfile()],
      buildRunnerConfig: (req) => ({ ...req, queryFn: (() => idleQuery()) as never }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'claude', permissionMode: 'plan' }),
    })
    expect(res.status).toBe(201)
  })

  it('rejects a job asking for a mode the profile’s engine cannot run', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
      queue: {},
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          cwd: '/tmp/project',
          profile: 'kimi',
          prompt: 'do the thing',
          permissionMode: 'acceptEdits',
        },
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/'acceptEdits' is not supported/)
  })

  it('refuses to start when a provider profile defaults to a mode its engine cannot run', () => {
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [{ ...providerProfile(), defaults: { permissionMode: 'acceptEdits' } }],
        createEngineRunner: ({ config }) => fakeRunner('x', config),
      }),
    ).toThrow(/does not support/)
  })

  it('refuses a session asking for a capability its profile does not grant', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [{ ...providerProfile(), session: { capabilities: ['web_fetch'] } }],
      createEngineRunner,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        profile: 'kimi',
        capabilities: ['web_fetch', 'download'],
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/does not grant: download/)
    expect(createEngineRunner).not.toHaveBeenCalled()
  })

  it('passes a narrowing capability request through to the engine factory', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [{ ...providerProfile(), session: { capabilities: ['web_fetch', 'deliver_file'] } }],
      createEngineRunner,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi', capabilities: ['web_fetch'] }),
    })
    expect(res.status).toBe(201)
    expect(createEngineRunner.mock.calls[0]![0].config.capabilities).toEqual(['web_fetch'])
  })

  it('refuses client-supplied MCP servers on a provider profile', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        profile: 'kimi',
        // MCP tools are authoritative — a client that could name one could point
        // an authoritative tool at anything it liked.
        mcpServers: { evil: { type: 'http', url: 'https://attacker.example/mcp' } },
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/declared outside the session request/)
  })

  it('still lets claude sessions bring their own MCP servers', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [claudeProfile()],
      buildRunnerConfig: (req) => ({ ...req, queryFn: (() => idleQuery()) as never }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        profile: 'claude',
        mcpServers: { local: { command: 'my-server' } },
      }),
    })
    expect(res.status).toBe(201)
  })

  it('reports the engine on SessionInfo so surfaces can gate CLI-only affordances', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [claudeProfile()],
      buildRunnerConfig: (req) => ({ ...req, queryFn: (() => idleQuery()) as never }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'claude' }),
    })
    expect(((await res.json()) as { session: SessionInfo }).session.engine).toBe('claude')
  })
})

function idleQuery() {
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
