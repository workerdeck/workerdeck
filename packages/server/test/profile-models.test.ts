import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_CATALOG } from '@workerdeck/core'
import { modelMenu, type ModelOption, type ProfileInfo } from '@workerdeck/protocol'
import { writeAccount } from '../src/accounts/index.ts'
import { createMemoryProfileStore, createWorkerServer, type WorkerServer } from '../src/index.ts'
import { withAccountModels } from '../src/lib/models.ts'
import { ProfileModels } from '../src/services/profile-models.ts'
import { eventually, fakeHarness, ScriptedRunner } from './helpers.ts'

const MYTHOS: ModelOption = { value: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1', displayName: 'Mythos 5.1', reasoningEfforts: [] }

const LIVE_SDK_ROWS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'high'] },
  { value: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1', displayName: 'Mythos 5.1' },
]

let running: WorkerServer | undefined
const dirs: string[] = []
afterEach(async () => {
  await running?.close()
  running = undefined
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wd-profile-models-'))
  dirs.push(dir)
  return dir
}

async function profilesOf(base: string): Promise<Map<string, ProfileInfo>> {
  const { profiles } = (await (await fetch(`${base}/profiles`)).json()) as { profiles: ProfileInfo[] }
  return new Map(profiles.map((p) => [p.name, p]))
}

function values(profile: ProfileInfo | undefined): string[] {
  return (profile?.models ?? []).map((m) => m.value)
}

describe('withAccountModels', () => {
  it('keeps the catalog as is when the account adds nothing', () => {
    const live = [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }]
    expect(withAccountModels(CLAUDE_CATALOG.models, live)).toBe(CLAUDE_CATALOG.models)
    expect(withAccountModels(CLAUDE_CATALOG.models, undefined)).toBe(CLAUDE_CATALOG.models)
  })

  it('appends a model of a new line as that line primary, keeping every catalog row', () => {
    const merged = withAccountModels(CLAUDE_CATALOG.models, [MYTHOS])
    expect(merged.slice(0, -1).map((m) => m.value)).toEqual(CLAUDE_CATALOG.models.map((m) => m.value))
    expect(merged.at(-1)).toEqual({ ...MYTHOS, primary: true })
  })

  it('puts a newer model of a known line ahead of that line and moves the primary mark to it', () => {
    const catalog: ModelOption[] = [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', primary: true },
      { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', primary: true },
    ]
    const merged = withAccountModels(catalog, [{ value: 'claude-opus-5-6', displayName: 'Opus 5.6', primary: true }])
    expect(merged.map((m) => [m.value, m.primary === true])).toEqual([
      ['claude-opus-5-6', true],
      ['opus', false],
      ['claude-opus-5', false],
      ['sonnet', true],
    ])
  })

  it('keeps the account order for several added rows of one line, newest first and primary', () => {
    const older: ModelOption = { value: 'claude-mythos-5', resolvedModel: 'claude-mythos-5', displayName: 'Mythos 5' }
    const merged = withAccountModels(CLAUDE_CATALOG.models, [MYTHOS, older])
    expect(merged.slice(-2).map((m) => [m.value, m.primary === true])).toEqual([
      ['claude-mythos-5-1', true],
      ['claude-mythos-5', false],
    ])
    expect(modelMenu(merged).main.map((m) => m.value)).toContain('claude-mythos-5-1')
    expect(modelMenu(merged).main.map((m) => m.value)).not.toContain('claude-mythos-5')
  })

  it('places added rows of a known line where the account lists them', () => {
    const catalog: ModelOption[] = [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', primary: true },
      { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5' },
    ]
    const live: ModelOption[] = [
      { value: 'claude-opus-5-7', displayName: 'Opus 5.7' },
      { value: 'claude-opus-5-6', displayName: 'Opus 5.6' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5' },
      { value: 'claude-opus-4-9', displayName: 'Opus 4.9' },
    ]
    const merged = withAccountModels(catalog, live)
    expect(merged.map((m) => [m.value, m.primary === true])).toEqual([
      ['claude-opus-5-7', true],
      ['claude-opus-5-6', false],
      ['opus', false],
      ['claude-opus-5', false],
      ['claude-opus-4-9', false],
    ])
    expect(modelMenu(merged).main.map((m) => m.value)).toEqual(['claude-opus-5-7'])
  })

  it('treats a row matching a catalog row by resolved id as known', () => {
    const live = [{ value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }]
    expect(withAccountModels(CLAUDE_CATALOG.models, live)).toBe(CLAUDE_CATALOG.models)
  })
})

describe('per-account model lists on GET /profiles', () => {
  it("learns a profile's models from its session and leaves other profiles on the catalog", async () => {
    const harness = fakeHarness(LIVE_SDK_ROWS)
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [
        { name: 'cyber', configDir: configDir() },
        { name: 'plain', configDir: configDir() },
      ],
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    expect(values((await profilesOf(base)).get('cyber'))).not.toContain('claude-mythos-5-1')
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'cyber' }),
    })
    expect(res.status).toBe(201)

    const after = await eventually(async () => {
      const profiles = await profilesOf(base)
      expect(values(profiles.get('cyber'))).toContain('claude-mythos-5-1')
      return profiles
    })
    expect(values(after.get('cyber'))).toEqual([...CLAUDE_CATALOG.models.map((m) => m.value), 'claude-mythos-5-1'])
    expect(after.get('cyber')!.models!.at(-1)!.primary).toBe(true)
    expect(values(after.get('plain'))).toEqual(CLAUDE_CATALOG.models.map((m) => m.value))
  })

  it('probes every Claude profile at startup with that profile env and never a provider profile', async () => {
    const cyberDir = configDir()
    const probed: Array<string | undefined> = []
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [
        { name: 'cyber', configDir: cyberDir },
        { name: 'plain', configDir: configDir() },
        { name: 'api', engine: 'provider', provider: { id: 'test', model: 'test-model' } },
      ],
      createEngineRunner: () => {
        throw new Error('not used')
      },
      probeModels: {
        probe: async (env) => {
          probed.push(env.CLAUDE_CONFIG_DIR)
          return env.CLAUDE_CONFIG_DIR === cyberDir ? [MYTHOS] : undefined
        },
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const profiles = await eventually(async () => {
      const all = await profilesOf(base)
      expect(values(all.get('cyber'))).toContain('claude-mythos-5-1')
      return all
    })
    expect(probed).toHaveLength(2)
    expect(probed).toContain(cyberDir)
    expect(values(profiles.get('plain'))).not.toContain('claude-mythos-5-1')
  })

  it('reprobes when the account is disconnected and drops the rows the old account added', async () => {
    const dir = configDir()
    writeAccount(dir, ['sk-ant-oat01', 'FAKE'].join('-'), new Date())
    const answers: Array<ModelOption[] | undefined> = [[MYTHOS], undefined]
    let calls = 0
    running = createWorkerServer({
      authenticate: () => ({ canManageProfiles: true, user: 'tobias' }),
      allowedCwdRoots: ['/tmp'],
      allowedConfigDirRoots: [tmpdir()],
      profileStore: createMemoryProfileStore([{ name: 'cyber', configDir: dir }]),
      probeModels: { probe: async () => answers[calls++] },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`
    await eventually(async () => expect(values((await profilesOf(base)).get('cyber'))).toContain('claude-mythos-5-1'))

    expect((await fetch(`${base}/profiles/cyber/account`, { method: 'DELETE' })).status).toBe(200)
    await eventually(() => expect(calls).toBe(2))
    expect(values((await profilesOf(base)).get('cyber'))).toEqual(CLAUDE_CATALOG.models.map((m) => m.value))
  })
})

describe('ProfileModels producers', () => {
  const profile: ProfileInfo = { name: 'cyber', configDir: '/tmp/cyber' }
  const B: ModelOption[] = [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5' }]

  function deferredProbes() {
    const pending: Array<(models: ModelOption[] | undefined) => void> = []
    const models = new ProfileModels({
      sessionEnvFor: () => ({}),
      probe: { probe: () => new Promise((resolve) => pending.push(resolve)) },
    })
    return { models, pending }
  }

  it('drops a probe that started under an older generation, whatever order they finish in', async () => {
    const { models, pending } = deferredProbes()
    const fromA = models.probe(profile)
    const fromB = models.refresh(profile)
    pending[1]!(B)
    await fromB
    pending[0]!([MYTHOS])
    await fromA
    expect(models.get('cyber')).toEqual(B)
  })

  it('drops a probe that finishes after the profile was deleted', async () => {
    const { models, pending } = deferredProbes()
    const fromA = models.probe(profile)
    models.forget('cyber')
    pending[0]!([MYTHOS])
    await fromA
    expect(models.get('cyber')).toBeUndefined()
  })

  it('keeps a session reading that arrived after a slower probe started', async () => {
    const { models, pending } = deferredProbes()
    const runner = new ScriptedRunner('s1', { cwd: '/tmp', profile: 'cyber' }, { engine: 'claude' })
    models.watch(runner)
    const probing = models.probe(profile)
    runner.emitAt({ type: 'capabilities', models: B, commands: [] })
    pending[0]!([MYTHOS])
    await probing
    expect(models.get('cyber')).toEqual(B)
  })

  it("ignores a session started under the profile's previous account", () => {
    const { models } = deferredProbes()
    const runner = new ScriptedRunner('s1', { cwd: '/tmp', profile: 'cyber' }, { engine: 'claude' })
    models.watch(runner)
    models.forget('cyber')
    runner.emitAt({ type: 'capabilities', models: [MYTHOS], commands: [] })
    expect(models.get('cyber')).toBeUndefined()
  })
})
