import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { CodexRunner, CODEX_CATALOG } from '@workerdeck/core'
import type { EngineAdapter, EngineAvailability, SessionRunnerConfig } from '@workerdeck/core'
import type { AppServerConnection } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type ProfileInfo, type ServerFrame } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

const USAGE = {
  inputTokens: 100,
  cachedInputTokens: 40,
  cacheWriteInputTokens: 10,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  totalTokens: 125,
}

/**
 * The real codex adapter shape with the binary swapped for a scripted
 * app-server JSON-RPC peer — what the `engines` override exists for: the full
 * HTTP→adapter→CodexRunner→WS path runs, and `pnpm test` spawns no binary.
 * Each `turns` entry is the agent's answer text for one turn.
 */
function fakeCodexAdapter(options: {
  turns?: string[]
  probe?: () => EngineAvailability
  onCreate?: (config: SessionRunnerConfig) => void
}): { adapter: EngineAdapter; probeCalls: () => number } {
  let probeCalls = 0
  let turnIndex = 0
  const adapter: EngineAdapter = {
    engine: 'codex',
    capabilities: ENGINE_CAPABILITIES.codex,
    catalog: CODEX_CATALOG,
    checkAvailability: async () => {
      probeCalls += 1
      return options.probe?.() ?? { available: 'unknown' }
    },
    createRunner: ({ config, profile }) => {
      options.onCreate?.(config)
      let notify: ((method: string, params: unknown) => void) | undefined
      const connection: AppServerConnection = {
        request: async (method) => {
          if (method === 'thread/start' || method === 'thread/resume') {
            return { thread: { id: 'thread-1' } }
          }
          if (method === 'turn/start') {
            const text = options.turns?.[turnIndex++] ?? 'done'
            notify?.('item/completed', {
              threadId: 'thread-1',
              turnId: 't1',
              item: { id: 'a1', type: 'agentMessage', text },
            })
            notify?.('thread/tokenUsage/updated', {
              threadId: 'thread-1',
              turnId: 't1',
              tokenUsage: { last: USAGE, total: USAGE },
            })
            notify?.('turn/completed', {
              threadId: 'thread-1',
              turn: { id: 't1', status: 'completed' },
            })
            return { turn: { id: 't1', status: 'inProgress' } }
          }
          return {}
        },
        notify: () => {},
        onNotification: (handler) => {
          notify = handler
        },
        onRequest: () => {},
        onClose: () => {},
        close: () => {},
      }
      return new CodexRunner({
        ...config,
        codexHome: profile?.codexHome,
        connectFn: () => connection,
      })
    },
  }
  return { adapter, probeCalls: () => probeCalls }
}

const codexProfile = (extra: Partial<ProfileInfo> = {}): ProfileInfo => ({
  name: 'codex',
  engine: 'codex',
  ...extra,
})

let running: WorkerServer | undefined
let scratchDir: string | undefined
afterEach(async () => {
  vi.useRealTimers()
  await running?.close()
  running = undefined
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true })
  scratchDir = undefined
})

describe('codex engine over the gateway', () => {
  it('creates, watches, and completes a codex session end to end', async () => {
    const { adapter } = fakeCodexAdapter({ turns: ['hello from codex'] })
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [codexProfile()],
      engines: { codex: adapter },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    // The cold-start promise, codex edition: catalog + record on request one.
    const profiles = (await (await fetch(`${base}/profiles`)).json()) as { profiles: ProfileInfo[] }
    expect(profiles.profiles[0]!.models?.[0]?.value).toBe('gpt-5.6-sol')
    expect(profiles.profiles[0]!.models?.[0]?.reasoningEfforts).toContain('ultra')
    expect(profiles.profiles[0]!.capabilities?.interactiveApprovals).toBe(false)
    expect(profiles.profiles[0]!.capabilities?.streaming).toBe('token')

    const created = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: '/tmp/project',
        profile: 'codex',
        prompt: 'say hello',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      }),
    })
    expect(created.status).toBe(201)
    const { session } = (await created.json()) as { session: { id: string; engine: string } }
    expect(session.engine).toBe('codex')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${session.id}/ws`)
    const frames: ServerFrame[] = []
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame))
    await vi.waitFor(() => {
      const attached = frames.find((f) => f.type === 'attached')
      expect(attached).toBeDefined()
      // The attach snapshot is the session-level capability source.
      expect(
        (attached as { session: { capabilities?: { streaming?: string } } }).session.capabilities
          ?.streaming,
      ).toBe('token')
      const events = frames.filter((f) => f.type === 'event').map((f) => f.event)
      expect(events.some((e) => e.type === 'turn_result' && e.result === 'hello from codex')).toBe(
        true,
      )
    })
    ws.close()
  })

  it('refuses the request fields the codex record forswears', async () => {
    const { adapter } = fakeCodexAdapter({})
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [codexProfile()],
      engines: { codex: adapter },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const create = async (body: Record<string, unknown>) => {
      const res = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/p', profile: 'codex', ...body }),
      })
      return { status: res.status, error: ((await res.json()) as { error?: string }).error }
    }

    expect(await create({ permissionMode: 'plan' })).toMatchObject({
      status: 400,
      error: expect.stringMatching(/not supported by profile 'codex'/),
    })
    expect(await create({ mcpServers: { x: { type: 'http', url: 'https://x' } } })).toMatchObject({
      status: 400,
      error: expect.stringMatching(/declared outside the session request/),
    })
    expect(await create({ maxTurns: 3 })).toMatchObject({
      status: 400,
      error: expect.stringMatching(/maxTurns/),
    })
    expect(await create({ settingSources: ['project'] })).toMatchObject({
      status: 400,
      error: expect.stringMatching(/settingSources/),
    })
    expect(await create({ resume: 't', forkSession: true })).toMatchObject({
      status: 400,
      error: expect.stringMatching(/fork/),
    })
  })

  it('415s the attachment kinds the codex record forswears, at upload', async () => {
    const { adapter } = fakeCodexAdapter({})
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [codexProfile()],
      engines: { codex: adapter },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    const created = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'codex' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    const upload = (name: string, mediaType: string) =>
      fetch(`${base}/sessions/${session.id}/attachments?name=${name}`, {
        method: 'POST',
        headers: { 'content-type': mediaType },
        body: 'payload',
      })

    // No codex representation for a PDF — refused at the door, before the bytes
    // are held and a later send can trip over them.
    const pdf = await upload('doc.pdf', 'application/pdf')
    expect(pdf.status).toBe(415)
    expect(((await pdf.json()) as { error: string }).error).toMatch(/codex engine does not accept document/)
    // Text is in the record: it inlines into the prompt envelope.
    expect((await upload('notes.txt', 'text/plain')).status).toBe(201)
  })

  it('400s reasoningEffort on an engine whose record has none', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [
        {
          name: 'kimi',
          engine: 'provider',
          provider: { id: 'moonshotai', model: 'kimi-k3' },
        },
      ],
      createEngineRunner: () => {
        throw new Error('unreachable — the 400 must precede assembly')
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/p', profile: 'kimi', reasoningEffort: 'high' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/reasoningEffort/)
  })

  it('strips questionBehavior for engines without an approval channel', async () => {
    let captured: SessionRunnerConfig | undefined
    const { adapter } = fakeCodexAdapter({ onCreate: (config) => (captured = config) })
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [codexProfile()],
      engines: { codex: adapter },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/p', profile: 'codex', questionBehavior: 'auto' }),
    })
    expect(res.status).toBe(201)
    expect(captured?.questionBehavior).toBeUndefined()
  })

  it('validates codexHome like configDir, and refuses undeliverable instructions', () => {
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [codexProfile({ codexHome: '/definitely/not/here' })],
      }),
    ).toThrow(/codexHome does not exist/)
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [codexProfile({ session: { instructions: 'be nice' } })],
      }),
    ).toThrow(/AGENTS\.md/)
  })

  it('accepts a codexHome that exists, without requiring an engine factory', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'cw-codex-home-'))
    const { adapter } = fakeCodexAdapter({})
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [codexProfile({ codexHome: scratchDir })],
      engines: { codex: adapter },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/profiles`)
    expect(res.status).toBe(200)
  })
})

describe('availability', () => {
  it('stamps the probe verdict on GET /profiles, and re-probes after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let verdict: EngineAvailability = {
      available: false,
      reason: 'codex is not logged in for this profile’s environment',
    }
    const { adapter, probeCalls } = fakeCodexAdapter({ probe: () => verdict })
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [codexProfile()],
      engines: { codex: adapter },
      checkCredentials: true,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    await vi.waitFor(async () => {
      const { profiles } = (await (await fetch(`${base}/profiles`)).json()) as {
        profiles: ProfileInfo[]
      }
      expect(profiles[0]!.available).toBe(false)
      expect(profiles[0]!.unavailableReason).toMatch(/not logged in/)
    })
    const afterLaunch = probeCalls()

    // Inside the TTL nothing re-probes; past it, the next read refreshes.
    await fetch(`${base}/profiles`)
    expect(probeCalls()).toBe(afterLaunch)
    verdict = { available: true }
    vi.setSystemTime(Date.now() + 61_000)
    await fetch(`${base}/profiles`)
    await vi.waitFor(async () => {
      expect(probeCalls()).toBeGreaterThan(afterLaunch)
      const { profiles } = (await (await fetch(`${base}/profiles`)).json()) as {
        profiles: ProfileInfo[]
      }
      expect(profiles[0]!.available).toBe(true)
      expect(profiles[0]!.unavailableReason).toBeUndefined()
    })
  })

  it('gates nothing: create against an unavailable profile still proceeds', async () => {
    const { adapter } = fakeCodexAdapter({
      probe: () => ({ available: false, reason: 'not logged in' }),
      turns: ['ran anyway'],
    })
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [codexProfile()],
      engines: { codex: adapter },
      checkCredentials: true,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/p', profile: 'codex', prompt: 'go' }),
    })
    // Display-only by design: a stale probe must never turn into an outage.
    expect(res.status).toBe(201)
  })

  it("leaves 'unknown' unstamped — a probe that couldn't run proves nothing", async () => {
    const { adapter } = fakeCodexAdapter({ probe: () => ({ available: 'unknown' }) })
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [codexProfile()],
      engines: { codex: adapter },
      checkCredentials: true,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    await vi.waitFor(async () => {
      const { profiles } = (await (
        await fetch(`http://127.0.0.1:${port}/v1/profiles`)
      ).json()) as { profiles: ProfileInfo[] }
      expect(profiles[0]!.available).toBeUndefined()
      expect(profiles[0]!.unavailableReason).toBeUndefined()
    })
  })
})
