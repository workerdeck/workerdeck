import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EngineAdapter, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type ProfileInfo, type SessionInfo } from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { ScriptedRunner } from './helpers.ts'

// The session's own model as a real engine reports it before its first turn: what it was asked for.
class ModelRunner extends ScriptedRunner {
  constructor(id: string, config: SessionRunnerConfig) {
    super(id, config, { engine: 'claude', capabilities: ENGINE_CAPABILITIES.claude })
  }

  info(): SessionInfo {
    const info = super.info()
    return this.config.model === undefined ? info : { ...info, model: this.config.model }
  }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

let configDir: string
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wd-model-name-'))
})
afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

async function start(): Promise<string> {
  let minted = 0
  const adapter: EngineAdapter = {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: {
      models: [
        { value: 'default', displayName: 'Default (recommended)' },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
      ],
      provenance: 'test',
      defaultModel: 'sonnet',
    },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => new ModelRunner(id ?? `session-${++minted}`, config),
  }
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [
      { name: 'plain', engine: 'claude', configDir } satisfies ProfileInfo,
      { name: 'opus', engine: 'claude', configDir, defaults: { model: 'opus' } } satisfies ProfileInfo,
    ],
    engines: { claude: adapter },
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return `http://127.0.0.1:${port}/v1`
}

async function create(base: string, body: Record<string, unknown>): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session
}

describe('exact models', () => {
  it('runs a short name, a variant and no model at all as one exact id, and names it', async () => {
    const base = await start()
    const sessions = await Promise.all([
      create(base, { cwd: '/tmp', profile: 'plain', model: 'opus' }),
      create(base, { cwd: '/tmp', profile: 'plain', model: 'opus[1m]' }),
      create(base, { cwd: '/tmp', profile: 'plain', model: 'claude-opus-5-5' }),
      create(base, { cwd: '/tmp', profile: 'opus' }),
      create(base, { cwd: '/tmp', profile: 'plain' }),
      create(base, { cwd: '/tmp', profile: 'plain', model: 'claude-mystery-9' }),
      create(base, { cwd: '/tmp', profile: 'plain', model: '  ' }),
      create(base, { cwd: '/tmp', profile: 'plain', model: 'default' }),
    ])
    const listed = ((await (await fetch(`${base}/sessions`)).json()) as { sessions: SessionInfo[] }).sessions
    const shown = sessions.map((s) => listed.find((l) => l.id === s.id)).map((s) => [s?.model, s?.modelName])
    expect(shown).toEqual([
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-opus-5-5[1m]', 'Opus 5.5'],
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-mystery-9', undefined],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ])
  })

  it('stores an agent with the exact model it runs, also when it names none', async () => {
    const base = await start()
    const post = async (body: unknown) =>
      (await (await fetch(`${base}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as {
        agent: { id: string; config: { model?: string } }
      }
    const named = await post({ name: 'Short', config: { cwd: '/tmp', profile: 'plain', model: 'opus' } })
    const none = await post({ name: 'None', config: { cwd: '/tmp', profile: 'opus' } })
    expect([named.agent.config.model, none.agent.config.model]).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    const patched = (await (
      await fetch(`${base}/agents/${named.agent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: { model: 'sonnet' } }),
      })
    ).json()) as { agent: { config: { model?: string } } }
    expect(patched.agent.config.model).toBe('claude-sonnet-5-5')
    const moved = (await (
      await fetch(`${base}/agents/${named.agent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: { profile: 'opus' } }),
      })
    ).json()) as { agent: { config: { model?: string } } }
    expect(moved.agent.config.model).toBe('claude-opus-5-5')
  })
})
