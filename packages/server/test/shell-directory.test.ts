import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHELL_READ_DEFAULT_LINES, SHELL_READ_MAX_LINES } from '@workerdeck/protocol'
import { installedShellDirectory, type Runner } from '@workerdeck/core'
import { createShellDirectory, createShellRegistry, loadPty, type ShellRegistry } from '../src/services/shells.ts'
import { sandboxedProviderProfile, type EngineRunnerContext } from '../src/index.ts'
import { fakeHarness, fakeRunner } from './helpers.ts'
import { createSession, shellFixture } from './shell-helpers.ts'

const pty = await loadPty()
const withPty = describe.skipIf(pty === null)

const dirs: string[] = []
const registries: ShellRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) {
    registry.killAll('server_stopped')
    await registry.flush()
  }
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wd-shell-dir-')))
  dirs.push(dir)
  return dir
}

function makeRegistry(): ShellRegistry {
  const created = createShellRegistry({ generation: 'gen-a', artifactDir: tempDir() })
  registries.push(created)
  return created
}

function runner(id: string): Runner {
  return fakeRunner(id, { cwd: tempDir() })
}

async function run(shells: ShellRegistry, owner: Runner, command: string): Promise<string> {
  const spawned = await shells.spawn({ runner: owner, command, owner: 'user' })
  await new Promise<void>((resolve) => {
    if (spawned.source.info().status !== 'running') {
      resolve()
      return
    }
    const off = spawned.source.subscribe(() => {
      if (spawned.source.info().status !== 'running') {
        off()
        resolve()
      }
    })
  })
  return spawned.shell.id
}

withPty('createShellDirectory', () => {
  it('reads the text view tail for the session that owns the shell', async () => {
    const registry = makeRegistry()
    const directory = createShellDirectory(registry)
    const id = await run(registry, runner('s1'), 'for i in 1 2 3 4 5; do echo line$i; done')

    const all = await directory.read('s1', id)
    expect(all).toMatchObject({ lines: 5, totalLines: 5, truncated: false, text: 'line1\nline2\nline3\nline4\nline5' })
    expect(all!.shell).toMatchObject({ id, ordinal: 1, status: 'exited', exitCode: 0, owner: 'user' })

    const tail = await directory.read('s1', id, { tail: 2 })
    expect(tail).toMatchObject({ lines: 2, totalLines: 5, truncated: true, text: 'line4\nline5' })

    const listed = await directory.list('s1')
    expect(listed.map((shell) => shell.id)).toEqual([id])
  })

  it("answers another session's shell id as missing, and lists nothing for it", async () => {
    const registry = makeRegistry()
    const directory = createShellDirectory(registry)
    const id = await run(registry, runner('s1'), 'echo secret')
    await run(registry, runner('s2'), 'echo mine')

    expect(await directory.read('s2', id)).toBeUndefined()
    expect(await directory.read('nobody', id)).toBeUndefined()
    expect((await directory.list('s2')).some((shell) => shell.id === id)).toBe(false)
    expect(await directory.list('nobody')).toEqual([])
  })

  it('clamps an absurd tail and defaults an absent one', async () => {
    const registry = makeRegistry()
    const directory = createShellDirectory(registry)
    const id = await run(registry, runner('s1'), 'for i in $(seq 1 60); do echo line$i; done')

    expect(await directory.read('s1', id, { tail: SHELL_READ_MAX_LINES * 10 })).toMatchObject({ lines: 60, truncated: false })
    const seen = await directory.read('s1', id)
    expect(seen!.lines).toBe(Math.min(60, SHELL_READ_DEFAULT_LINES))
  })
})

function toolNames(harness: ReturnType<typeof fakeHarness>): string[] {
  const servers = (harness.captured.options?.mcpServers ?? {}) as Record<string, { instance: unknown }>
  const instance = servers.workerdeck?.instance as Record<string, Record<string, unknown>> | undefined
  return Object.keys(instance?.['_registeredTools'] ?? {})
}

describe('the gateway stamps the directory only where a shell of that session could exist', () => {
  const fixture = shellFixture('wd-shell-gate-')
  afterEach(() => fixture.cleanup())

  it('offers the read tools to a host-cwd engine', async () => {
    const harness = fakeHarness()
    const { base } = await fixture.startShellServer(harness)
    await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(toolNames(harness)).toEqual(['peers_list', 'peers_peek', 'peers_send', 'shell_list', 'shell_read'])
  })

  it('withholds them from a provider session, which has no host cwd to run a shell in', async () => {
    const harness = fakeHarness()
    const configs: Array<Record<string, unknown>> = []
    const { base } = await fixture.startShellServer(harness, {
      profiles: [sandboxedProviderProfile('sandboxed', { id: 'openai-compatible', model: 'test-model' })],
      createEngineRunner: (ctx: EngineRunnerContext) => {
        configs.push(ctx.config as unknown as Record<string, unknown>)
        return fakeRunner('provider-1', ctx.config)
      },
    })
    await createSession(base, 'operator', { profile: 'sandboxed', prompt: 'hi' })
    expect(configs).toHaveLength(1)
    expect(configs[0]!.shells).toBeUndefined()
    expect(configs[0]!.peers).toBeDefined()
  })

  it('offers no shell tool at all when the shell switch is off', async () => {
    const harness = fakeHarness()
    const { base } = await fixture.startServer(harness)
    await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(toolNames(harness)).toContain('peers_list'))
    expect(toolNames(harness).some((name) => name.startsWith('shell_'))).toBe(false)
    expect(installedShellDirectory()).toBeUndefined()
  })
})
