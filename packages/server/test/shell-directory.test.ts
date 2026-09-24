import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ENGINE_CAPABILITIES,
  SHELL_READ_DEFAULT_LINES,
  SHELL_READ_MAX_LINES,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
} from '@workerdeck/protocol'
import {
  getEngineAdapter,
  installedShellDirectory,
  shellOwnershipRefusal,
  SHELL_REFUSAL,
  type EngineAdapter,
  type LocalShellSource,
  type Runner,
  type SessionRunnerConfig,
} from '@workerdeck/core'
import { createShellDirectory, createShellRegistry, loadPty, type ShellRegistry } from '../src/services/shells.ts'
import { createFileSessionStore, sandboxedProviderProfile, type EngineRunnerContext, type WorkerServerOptions } from '../src/index.ts'
import { fakeHarness, fakeRunner } from './helpers.ts'
import { attachSocket, createSession, shellFixture } from './shell-helpers.ts'

const ECHO_KEYS = 'echo reloaded; while read -r k; do echo "got $k"; done'

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

// A live runner as the directory sees it: the shell it starts must land a transcript row through queueLocalCommand.
function agentRunner(id: string): Runner & { rows: LocalShellSource[] } {
  const rows: LocalShellSource[] = []
  return { ...runner(id), rows, queueLocalCommand: (source) => rows.push(source as LocalShellSource) }
}

function agentDirectory(registry: ShellRegistry, ...runners: Runner[]) {
  return createShellDirectory(registry, { runnerFor: (id) => runners.find((r) => r.id === id) })
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

  it('reads a redrawing program as its current screen, and defaults an interactive shell to it', async () => {
    const registry = makeRegistry()
    const directory = createShellDirectory(registry)
    const id = await run(registry, runner('s1'), "printf 'building 1/3\\nstep a\\n\\033[2A\\033[Jbuilt 3/3\\nall done\\n'")

    const lines = await directory.read('s1', id, { view: 'lines' })
    expect(lines!.text).toBe('building 1/3\nstep a\nbuilt 3/3\nall done')
    const screen = await directory.read('s1', id)
    expect(screen).toMatchObject({ view: 'screen', text: 'built 3/3\nall done', lines: 2, truncated: false })
    expect(screen!.shell.interactive).toBe(true)
    expect(await registry.output('s1', id, { view: 'screen' })).toBe('built 3/3\nall done')
  })

  it('renders the screen of a shell this generation never ran from its artifact', async () => {
    const dir = tempDir()
    const first = createShellRegistry({ generation: 'gen-a', artifactDir: dir })
    const owner = runner('s1')
    const id = await run(first, owner, "printf '\\033[?1049h\\033[5;3Hin the alt screen'")
    await first.flush()
    const second = createShellRegistry({ generation: 'gen-b', artifactDir: dir })
    registries.push(first, second)
    await second.hydrate()
    const screen = await second.output('s1', id, { view: 'screen' })
    expect(screen).toBe('\n\n\n\n  in the alt screen')
  })

  it('waits for text to appear, returns at once when it is already there, and reports a timeout and an exit', async () => {
    const registry = makeRegistry()
    const directory = createShellDirectory(registry)
    const owner = runner('s1')
    const spawned = await registry.spawn({
      runner: owner,
      command: 'echo starting; sleep 0.4; echo ready in 12ms; sleep 30',
      owner: 'user',
    })
    const id = spawned.shell.id

    const ready = await directory.read('s1', id, { waitFor: ['ready in', 'error'], timeoutMs: 5000 })
    expect(ready!.wait).toMatchObject({ outcome: 'matched', match: 'ready in' })
    expect(ready!.wait!.ms).toBeGreaterThan(100)
    expect(ready!.text).toContain('ready in 12ms')

    const again = await directory.read('s1', id, { waitFor: ['ready in'], timeoutMs: 5000 })
    expect(again!.wait).toMatchObject({ outcome: 'matched' })
    expect(again!.wait!.ms).toBeLessThan(100)

    const never = await directory.read('s1', id, { waitFor: ['never printed'], timeoutMs: 300 })
    expect(never!.wait).toMatchObject({ outcome: 'timeout' })
    expect(never!.wait!.ms).toBeGreaterThanOrEqual(300)

    const quick = await run(registry, owner, 'echo bye')
    const exited = await directory.read('s1', quick, { waitFor: ['never printed'], timeoutMs: 5000 })
    expect(exited!.wait).toMatchObject({ outcome: 'exited' })
  })

  it('starts a shell for the agent through the same spawn, owner agent, with a transcript row, and waits for its text', async () => {
    const registry = makeRegistry()
    const owner = agentRunner('s1')
    const directory = agentDirectory(registry, owner)
    const result = await directory.run('s1', {
      command: 'echo booting; sleep 0.3; echo ready in 9ms; sleep 30',
      waitFor: ['ready in'],
      timeoutMs: 5000,
    })
    expect(result.shell).toMatchObject({ owner: 'agent', status: 'running', ordinal: 1 })
    expect(result.wait).toMatchObject({ outcome: 'matched', match: 'ready in' })
    expect(result.text).toContain('ready in 9ms')
    expect(owner.rows).toHaveLength(1)
    expect(owner.rows[0]!.info()).toMatchObject({ id: result.shell.id, owner: 'agent' })
    expect(registry.get('s1', result.shell.id)).toMatchObject({ owner: 'agent', status: 'running' })
    expect((await directory.list('s1')).map((shell) => [shell.id, shell.owner])).toEqual([[result.shell.id, 'agent']])

    const killed = await directory.kill('s1', result.shell.id)
    expect(killed).toMatchObject({ killed: true, shell: { id: result.shell.id, status: 'exited', endReason: 'killed' } })
    expect(await directory.kill('s1', result.shell.id)).toMatchObject({ killed: false, shell: { status: 'exited' } })
    await expect(directory.write('s1', result.shell.id, { keys: ['q'] })).rejects.toThrow(/has already ended/)
  })

  it('refuses to start a shell for a session it cannot reach a live runner for', async () => {
    const registry = makeRegistry()
    await expect(createShellDirectory(registry).run('s1', { command: 'true' })).rejects.toThrow(SHELL_REFUSAL)
    await expect(agentDirectory(registry, fakeRunner('s1', { cwd: tempDir() })).run('s1', { command: 'true' })).rejects.toThrow(
      SHELL_REFUSAL,
    )
    expect(await registry.list('s1')).toEqual([])
  })

  it('types data then keys into an agent shell, and a wait after the write matches only what came after it', async () => {
    const registry = makeRegistry()
    const owner = agentRunner('s1')
    const directory = agentDirectory(registry, owner)
    const started = await directory.run('s1', { command: ECHO_KEYS, waitFor: ['reloaded'], timeoutMs: 5000 })
    const id = started.shell.id
    expect(started.wait).toMatchObject({ outcome: 'matched' })

    const stale = await directory.write('s1', id, { keys: ['r', 'enter'], waitFor: ['reloaded'], timeoutMs: 500 })
    expect(stale!.wait).toMatchObject({ outcome: 'timeout' })
    expect(stale!.text).toContain('got r')

    const typed = await directory.write('s1', id, { data: 'hello', keys: ['enter'], waitFor: ['got hello'], timeoutMs: 5000 })
    expect(typed!.wait).toMatchObject({ outcome: 'matched', match: 'got hello' })
    expect(typed!.shell).toMatchObject({ id, owner: 'agent', status: 'running' })

    const plain = await directory.write('s1', id, { data: 'again\n' })
    expect(plain!.wait).toBeUndefined()
    const after = await directory.read('s1', id, { waitFor: ['got again'], timeoutMs: 5000 })
    expect(after!.wait).toMatchObject({ outcome: 'matched' })
    await expect(directory.write('s1', id, {})).rejects.toThrow(/nothing to write/)
    await expect(directory.write('s1', id, { keys: ['warp'] })).rejects.toThrow(/unknown key "warp"/)
  })

  it('encodes a cursor key the way the program asked for it: CSI normally, SS3 under application cursor mode', async () => {
    const registry = makeRegistry()
    const owner = agentRunner('s1')
    const directory = agentDirectory(registry, owner)
    const dump = 'while read -r k; do printf %s "$k" | od -An -tx1 | tr -s " "; done'
    const normal = await directory.run('s1', { command: `echo go; ${dump}`, waitFor: ['go'], timeoutMs: 5000 })
    const csi = await directory.write('s1', normal.shell.id, { keys: ['up', 'enter'], waitFor: ['1b 5b 41', '1b 4f 41'], timeoutMs: 5000 })
    expect(csi!.wait).toMatchObject({ outcome: 'matched', match: '1b 5b 41' })

    const application = await directory.run('s1', { command: `printf '\\033[?1h'; echo go; ${dump}`, waitFor: ['go'], timeoutMs: 5000 })
    const ss3 = await directory.write('s1', application.shell.id, {
      keys: ['up', 'enter'],
      waitFor: ['1b 5b 41', '1b 4f 41'],
      timeoutMs: 5000,
    })
    expect(ss3!.wait).toMatchObject({ outcome: 'matched', match: '1b 4f 41' })
  }, 15_000)

  it("refuses to type into or kill the user's shell with the rule named, and answers another session's as missing", async () => {
    const registry = makeRegistry()
    const owner = agentRunner('s1')
    const other = agentRunner('s2')
    const directory = agentDirectory(registry, owner, other)
    const spawned = await registry.spawn({ runner: owner, command: 'sleep 30', owner: 'user' })
    const id = spawned.shell.id
    await expect(directory.write('s1', id, { keys: ['q'] })).rejects.toThrow(shellOwnershipRefusal(id))
    await expect(directory.kill('s1', id)).rejects.toThrow(shellOwnershipRefusal(id))
    expect(registry.get('s1', id)?.status).toBe('running')

    const mine = await directory.run('s1', { command: 'sleep 30' })
    expect(await directory.write('s2', mine.shell.id, { keys: ['q'] })).toBeUndefined()
    expect(await directory.kill('s2', mine.shell.id)).toBeUndefined()
    expect(await directory.write('s2', id, { keys: ['q'] })).toBeUndefined()
    expect(registry.get('s1', mine.shell.id)?.status).toBe('running')
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

// A claude stand-in that names its engine session and goes idle, which is all dormancy needs to write a record.
function resumableRunner(id: string, config: SessionRunnerConfig): Runner & { config: SessionRunnerConfig } {
  const listeners = new Set<(event: SessionEvent) => void>()
  const events: SessionEvent[] = []
  let status: SessionInfo['status'] = 'starting'
  const emit = (body: SessionEventBody): void => {
    const event = { ...body, seq: events.length + 1, ts: Date.now() } as SessionEvent
    events.push(event)
    for (const listener of listeners) {
      listener(event)
    }
  }
  return {
    id,
    config,
    pendingApprovals: [],
    start: async () => {
      emit({
        type: 'system_init',
        sdkSessionId: config.resume ?? 'engine-session-1',
        model: 'test-model',
        cwd: config.cwd ?? '',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: 'test',
        mcpServers: [],
      })
      status = 'idle'
      emit({ type: 'status_changed', status: 'idle' })
    },
    info: () => ({
      id,
      sdkSessionId: config.resume ?? 'engine-session-1',
      status,
      cwd: config.cwd ?? '',
      engine: 'claude',
      capabilities: ENGINE_CAPABILITIES.claude,
      createdAt: 0,
      epoch: config.epoch,
      lastSeq: events.length,
      pendingPermissionCount: 0,
      scope: config.scope,
    }),
    subscribe: (listener, afterSeq = 0) => {
      for (const event of events) {
        if (event.seq > afterSeq) {
          listener(event)
        }
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendMessage: () => {},
    setTitle: () => {},
    resolvePermission: () => false,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    fail: () => {},
    close: () => emit({ type: 'session_closed', reason: 'server' }),
  }
}

function toolNames(harness: ReturnType<typeof fakeHarness>): string[] {
  const servers = (harness.captured.options?.mcpServers ?? {}) as Record<string, { instance: unknown }>
  const instance = servers.workerdeck?.instance as Record<string, Record<string, unknown>> | undefined
  return Object.keys(instance?.['_registeredTools'] ?? {})
}

describe('the gateway stamps the directory only where a shell of that session could exist', () => {
  const fixture = shellFixture('wd-shell-gate-')
  afterEach(() => fixture.cleanup())

  it('offers the read tools to a host-cwd engine, and no write tool while the agent is read-only', async () => {
    const harness = fakeHarness()
    const { base } = await fixture.startShellServer(harness)
    await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(toolNames(harness)).toEqual(['peers_list', 'peers_peek', 'peers_send', 'shell_list', 'shell_read'])
  })

  it('offers the write tools under agentWrite to a session an operator created, and never to a scoped principal', async () => {
    const harness = fakeHarness()
    const { base } = await fixture.startShellServer(harness, {
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite: 'gated' },
    })
    await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(toolNames(harness)).toEqual([
      'peers_list',
      'peers_peek',
      'peers_send',
      'shell_list',
      'shell_read',
      'shell_run',
      'shell_write',
      'shell_kill',
    ])

    const scoped = fakeHarness()
    const { base: scopedBase } = await fixture.startShellServer(scoped, {
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite: 'allow' },
    })
    await createSession(scopedBase, 'alice-a', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(scoped.captured.options).toBeDefined())
    expect(toolNames(scoped)).toEqual(['peers_list', 'peers_peek', 'peers_send', 'shell_list', 'shell_read'])
  })

  it('keeps the operator flag on the dormant record and re-derives the grant from the gateway on every rebuild', async () => {
    const built: Array<Runner & { config: SessionRunnerConfig }> = []
    const claude: EngineAdapter = {
      ...getEngineAdapter('claude'),
      createRunner: ({ config, id }) => {
        const made = resumableRunner(id ?? `session-${built.length + 1}`, config)
        built.push(made)
        return made
      },
    }
    const stateDir = fixture.tempDir()
    const gateway = (agentWrite: 'read-only' | 'gated' | 'allow'): Partial<WorkerServerOptions> => ({
      engines: { claude },
      parking: { store: createFileSessionStore({ dir: stateDir }), parkDelayMs: 10 },
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite },
    })
    const harness = fakeHarness()
    const { base } = await fixture.startServer(harness, gateway('gated'))
    const id = await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    expect(built).toHaveLength(1)
    expect(built[0]!.config).toMatchObject({ createdByOperator: true, shellAgentWrite: 'gated' })
    expect(built[0]!.config.shells).toBeDefined()
    await vi.waitFor(async () => expect((await createFileSessionStore({ dir: stateDir }).get(id))?.kind).toBe('dormant'))
    const stored = (await createFileSessionStore({ dir: stateDir }).get(id))!
    expect(stored.config.createdByOperator).toBe(true)
    expect('shells' in stored.config).toBe(false)
    expect('shellAgentWrite' in stored.config).toBe(false)
    await fixture.server().close()

    const second = await fixture.startServer(harness, gateway('read-only'))
    await attachSocket(second.wsBase, id, 'operator').then(({ ws }) => ws.close())
    expect(built).toHaveLength(2)
    expect(built[1]!.config).toMatchObject({ createdByOperator: true, resume: 'engine-session-1' })
    expect(built[1]!.config.shellAgentWrite).toBeUndefined()
    expect(built[1]!.config.shells).toBeDefined()
    await fixture.server().close()

    const third = await fixture.startServer(harness, gateway('allow'))
    await attachSocket(third.wsBase, id, 'operator').then(({ ws }) => ws.close())
    expect(built).toHaveLength(3)
    expect(built[2]!.config).toMatchObject({ createdByOperator: true, shellAgentWrite: 'allow' })
  })

  it('refuses a request that tries to stamp the principal or the grant itself', async () => {
    const harness = fakeHarness()
    const { base } = await fixture.startShellServer(harness, {
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite: 'allow' },
    })
    for (const body of [{ createdByOperator: true }, { shellAgentWrite: 'allow' }]) {
      const res = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer alice-a', 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: tempDir(), prompt: 'hi', ...body }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('host-only')
    }
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
