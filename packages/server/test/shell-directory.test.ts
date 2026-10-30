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
import { createShellDirectory, loadPty, type ShellRegistry } from '../src/services/shells.ts'
import { createFileSessionRecordStore, type EngineRunnerContext, sandboxedProviderProfile, type WorkerServerOptions } from '../src/index.ts'
import { fakeHarness, fakeRunner, fileRuntimeStore } from './helpers.ts'
import { attachSocket, createSession, ptySuite, registryFixture, shellFixture, type ScriptedChild } from './shell-helpers.ts'

const ECHO_KEYS = 'echo reloaded; while read -r k; do echo "got $k"; done'

const withPty = ptySuite(await loadPty(), 'shell-directory.test')

const { tempDir, makeRegistry, makeScripted, pty, runner, cleanup } = registryFixture('wd-shell-dir-')
afterEach(async () => {
  vi.useRealTimers()
  await cleanup()
})

// A live runner as the directory sees it: the shell it starts must land a transcript row through queueLocalCommand.
function agentRunner(id: string): Runner & { rows: LocalShellSource[] } {
  const rows: LocalShellSource[] = []
  return { ...runner(id), rows, queueLocalCommand: (source) => rows.push(source as LocalShellSource) }
}

function agentDirectory(registry: ShellRegistry, ...runners: Runner[]) {
  return createShellDirectory(registry, { runnerFor: (id) => runners.find((r) => r.id === id) })
}

// A scripted shell that printed `chunks` and exited, settled before it returns.
async function finished(shells: ShellRegistry, owner: Runner, chunks: string[]): Promise<string> {
  const spawned = await shells.spawn({ runner: owner, command: 'scripted', owner: 'user' })
  const child = pty.last()
  for (const chunk of chunks) {
    child.emit(chunk)
  }
  child.exit(0)
  return spawned.shell.id
}

// The screen behind a write settles on xterm's own timers, which the fake clock holds until it is advanced.
async function flushed<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    () => true,
    () => true,
  )
  for (;;) {
    await vi.advanceTimersByTimeAsync(1)
    if (await Promise.race([settled, Promise.resolve(false)])) {
      return promise
    }
  }
}

// The shell side of ECHO_KEYS: every line typed comes back as `got <line>`, after the tty's own echo of it.
function echoKeys(child: ScriptedChild): void {
  let line = ''
  child.respond = (data) => {
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        child.emit(`${line}\r\ngot ${line}\r\n`)
        line = ''
      } else {
        line += char
      }
    }
  }
}

describe('createShellDirectory', () => {
  it('reads the text view tail for the session that owns the shell', async () => {
    const registry = makeScripted()
    const directory = createShellDirectory(registry)
    const id = await finished(registry, runner('s1'), ['line1\r\nline2\r\n', 'line3\r\nline4\r\nline5\r\n'])

    const all = await directory.read('s1', id)
    expect(all).toMatchObject({ lines: 5, totalLines: 5, truncated: false, text: 'line1\nline2\nline3\nline4\nline5' })
    expect(all!.shell).toMatchObject({ id, ordinal: 1, status: 'exited', exitCode: 0, owner: 'user' })

    const tail = await directory.read('s1', id, { tail: 2 })
    expect(tail).toMatchObject({ lines: 2, totalLines: 5, truncated: true, text: 'line4\nline5' })

    const listed = await directory.list('s1')
    expect(listed.map((shell) => shell.id)).toEqual([id])
  })

  it("answers another session's shell id as missing, and lists nothing for it", async () => {
    const registry = makeScripted()
    const directory = createShellDirectory(registry)
    const id = await finished(registry, runner('s1'), ['secret\r\n'])
    await finished(registry, runner('s2'), ['mine\r\n'])

    expect(await directory.read('s2', id)).toBeUndefined()
    expect(await directory.read('nobody', id)).toBeUndefined()
    expect((await directory.list('s2')).some((shell) => shell.id === id)).toBe(false)
    expect(await directory.list('nobody')).toEqual([])
  })

  it('reads a redrawing program as its current screen, and defaults an interactive shell to it', async () => {
    const registry = makeScripted()
    const directory = createShellDirectory(registry)
    const id = await finished(registry, runner('s1'), ['building 1/3\r\nstep a\r\n', '\x1b[2A\x1b[Jbuilt 3/3\r\nall done\r\n'])

    const lines = await directory.read('s1', id, { view: 'lines' })
    expect(lines!.text).toBe('building 1/3\nstep a\nbuilt 3/3\nall done')
    const screen = await directory.read('s1', id)
    expect(screen).toMatchObject({ view: 'screen', text: 'built 3/3\nall done', lines: 2, truncated: false })
    expect(screen!.shell.interactive).toBe(true)
    expect(await registry.output('s1', id, { view: 'screen' })).toBe('built 3/3\nall done')
  })

  it('renders the screen of a shell this generation never ran from its artifact', async () => {
    const dir = tempDir()
    const first = makeScripted({ artifactDir: dir })
    const id = await finished(first, runner('s1'), ['\x1b[?1049h\x1b[5;3Hin the alt screen'])
    await first.flush()
    const second = makeScripted({ artifactDir: dir, generation: 'gen-b' })
    await second.hydrate()
    const screen = await second.output('s1', id, { view: 'screen' })
    expect(screen).toBe('\n\n\n\n  in the alt screen')
  })

  it('waits for text to appear, returns at once when it is already there, and reports a timeout and an exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const registry = makeScripted()
    const directory = createShellDirectory(registry)
    const owner = runner('s1')
    const spawned = await registry.spawn({ runner: owner, command: 'echo starting; sleep 1; echo ready; sleep 30', owner: 'user' })
    const child = pty.last()
    const id = spawned.shell.id
    child.emit('starting\r\n')

    const pending = directory.read('s1', id, { waitFor: ['ready in', 'error'], timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(400)
    child.emit('ready in 12ms\r\n')
    await vi.advanceTimersByTimeAsync(250)
    const ready = await pending
    expect(ready!.wait).toEqual({ outcome: 'matched', match: 'ready in', ms: 650 })
    expect(ready!.text).toBe('starting\nready in 12ms')

    const again = await directory.read('s1', id, { waitFor: ['ready in'], timeoutMs: 5000 })
    expect(again!.wait).toEqual({ outcome: 'matched', match: 'ready in', ms: 0 })

    const waiting = directory.read('s1', id, { waitFor: ['never printed'], timeoutMs: 300 })
    await vi.advanceTimersByTimeAsync(299)
    child.emit('noise\r\n')
    await vi.advanceTimersByTimeAsync(1)
    const never = await waiting
    expect(never!.wait).toEqual({ outcome: 'timeout', ms: 300 })

    const quick = await finished(registry, owner, ['bye\r\n'])
    const exited = await directory.read('s1', quick, { waitFor: ['never printed'], timeoutMs: 5000 })
    expect(exited!.wait).toEqual({ outcome: 'exited', ms: 0 })
  })

  it('refuses to start a shell for a session it cannot reach a live runner for', async () => {
    const registry = makeScripted()
    await expect(createShellDirectory(registry).run('s1', { command: 'true' })).rejects.toThrow(SHELL_REFUSAL)
    await expect(agentDirectory(registry, fakeRunner('s1', { cwd: tempDir() })).run('s1', { command: 'true' })).rejects.toThrow(
      SHELL_REFUSAL,
    )
    expect(registry.list('s1')).toEqual([])
    expect(pty.children).toEqual([])
  })

  it('types data then keys into an agent shell, and a wait after the write matches only what came after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const registry = makeScripted()
    const owner = agentRunner('s1')
    const directory = agentDirectory(registry, owner)
    const starting = directory.run('s1', { command: ECHO_KEYS, waitFor: ['reloaded'], timeoutMs: 5000 })
    while (pty.children.length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const child = pty.last()
    echoKeys(child)
    child.emit('reloaded\r\n')
    await vi.advanceTimersByTimeAsync(250)
    const started = await starting
    const id = started.shell.id
    expect(started.wait).toMatchObject({ outcome: 'matched', match: 'reloaded' })

    const staleWrite = directory.write('s1', id, { keys: ['r', 'enter'], waitFor: ['reloaded'], timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    const stale = await staleWrite
    expect(child.writes).toEqual(['r\r'])
    expect(stale!.wait).toEqual({ outcome: 'timeout', ms: 500 })
    expect(stale!.text).toBe('reloaded\nr\ngot r')

    const typed = await flushed(directory.write('s1', id, { data: 'hello', keys: ['enter'], waitFor: ['got hello'], timeoutMs: 5000 }))
    expect(child.writes.at(-1)).toBe('hello\r')
    expect(typed!.wait).toEqual({ outcome: 'matched', match: 'got hello', ms: 0 })
    expect(typed!.shell).toMatchObject({ id, owner: 'agent', status: 'running' })

    const plain = await flushed(directory.write('s1', id, { data: 'again\n' }))
    expect(child.writes.at(-1)).toBe('again\n')
    expect(plain!.wait).toBeUndefined()
    const after = await directory.read('s1', id, { waitFor: ['got again'], timeoutMs: 5000 })
    expect(after!.wait).toMatchObject({ outcome: 'matched' })
    await expect(flushed(directory.write('s1', id, {}))).rejects.toThrow(/nothing to write/)
    await expect(flushed(directory.write('s1', id, { keys: ['warp'] }))).rejects.toThrow(/unknown key "warp"/)
    expect(child.writes).toHaveLength(3)
  })

  it('encodes a cursor key the way the program asked for it: CSI normally, SS3 under application cursor mode', async () => {
    const registry = makeScripted()
    const owner = agentRunner('s1')
    const directory = agentDirectory(registry, owner)
    const normal = await directory.run('s1', { command: 'cat -v' })
    await directory.write('s1', normal.shell.id, { keys: ['up', 'enter'] })
    expect(pty.last().writes).toEqual(['\x1b[A\r'])

    const application = await directory.run('s1', { command: 'less' })
    pty.last().emit('\x1b[?1h')
    await directory.write('s1', application.shell.id, { keys: ['up', 'enter'] })
    expect(pty.last().writes).toEqual(['\x1bOA\r'])
  })

  it("refuses to type into or kill the user's shell with the rule named, and answers another session's as missing", async () => {
    const registry = makeScripted()
    const owner = agentRunner('s1')
    const other = agentRunner('s2')
    const directory = agentDirectory(registry, owner, other)
    const spawned = await registry.spawn({ runner: owner, command: 'sleep 30', owner: 'user' })
    const users = pty.last()
    const id = spawned.shell.id
    await expect(directory.write('s1', id, { keys: ['q'] })).rejects.toThrow(shellOwnershipRefusal(id))
    await expect(directory.kill('s1', id)).rejects.toThrow(shellOwnershipRefusal(id))
    expect(registry.get('s1', id)?.status).toBe('running')

    const mine = await directory.run('s1', { command: 'sleep 30' })
    expect(await directory.write('s2', mine.shell.id, { keys: ['q'] })).toBeUndefined()
    expect(await directory.kill('s2', mine.shell.id)).toBeUndefined()
    expect(await directory.write('s2', id, { keys: ['q'] })).toBeUndefined()
    expect(registry.get('s1', mine.shell.id)?.status).toBe('running')
    expect(users.writes).toEqual([])
    expect(pty.last().writes).toEqual([])
  })

  it("grants the agent a user's running shell, re-emits its row, types into it, and a revoke refuses the next write", async () => {
    const registry = makeScripted()
    const owner = agentRunner('s1')
    const other = agentRunner('s2')
    const directory = agentDirectory(registry, owner, other)
    const spawned = await registry.spawn({ runner: owner, command: ECHO_KEYS, owner: 'user' })
    const child = pty.last()
    echoKeys(child)
    const id = spawned.shell.id
    const redraws = vi.fn()
    spawned.source.subscribe(redraws)

    expect(await directory.grant('s2', id)).toBeUndefined()
    expect(registry.get('s1', id)?.agentWrite).toBeUndefined()
    expect(await directory.grant('s1', id)).toMatchObject({ id, owner: 'user', agentWrite: true })
    expect(spawned.source.info().agentWrite).toBe(true)
    expect(redraws).toHaveBeenCalledTimes(1)

    const typed = await directory.write('s1', id, { data: 'hi', keys: ['enter'], waitFor: ['got hi'], timeoutMs: 5000 })
    expect(typed!.wait).toMatchObject({ outcome: 'matched' })
    expect(child.writes).toEqual(['hi\r'])

    expect(registry.setAgentWrite('s1', id, false)).toMatchObject({ id, owner: 'user' })
    expect(registry.get('s1', id)?.agentWrite).toBeUndefined()
    await expect(directory.write('s1', id, { keys: ['q'] })).rejects.toThrow(shellOwnershipRefusal(id))
    await expect(directory.kill('s1', id)).rejects.toThrow(shellOwnershipRefusal(id))
    expect(child.writes).toEqual(['hi\r'])
  })

  it('ends a grant with its shell, grants nothing on an ended one, and answers an agent shell as already writable', async () => {
    const registry = makeScripted()
    const owner = agentRunner('s1')
    const directory = agentDirectory(registry, owner)
    const spawned = await registry.spawn({ runner: owner, command: 'sleep 30', owner: 'user' })
    const id = spawned.shell.id
    await directory.grant('s1', id)
    registry.kill('s1', id)
    expect(registry.get('s1', id)).toMatchObject({ status: 'exited' })
    expect(registry.get('s1', id)?.agentWrite).toBeUndefined()
    await expect(directory.grant('s1', id)).rejects.toThrow(/already ended/)

    const mine = await directory.run('s1', { command: 'sleep 30' })
    expect(await directory.grant('s1', mine.shell.id)).toMatchObject({ owner: 'agent' })
    expect(registry.get('s1', mine.shell.id)?.agentWrite).toBeUndefined()
    expect(() => registry.setAgentWrite('s1', mine.shell.id, true)).toThrow(/started by the agent/)
  })

  it('clamps an absurd tail and defaults an absent one', async () => {
    const registry = makeScripted()
    const directory = createShellDirectory(registry)
    const lines = Array.from({ length: 60 }, (_, i) => `line${i + 1}\r\n`)
    const id = await finished(registry, runner('s1'), [lines.slice(0, 30).join(''), lines.slice(30).join('')])

    expect(await directory.read('s1', id, { tail: SHELL_READ_MAX_LINES * 10 })).toMatchObject({ lines: 60, truncated: false })
    const seen = await directory.read('s1', id)
    expect(seen!.lines).toBe(Math.min(60, SHELL_READ_DEFAULT_LINES))
  })
})

withPty('createShellDirectory over a real PTY', () => {
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
    expect(toolNames(harness)).toEqual(['session_info', 'set_status', 'peers_list', 'peers_peek', 'peers_send', 'shell_list', 'shell_read'])
  })

  it('offers the write tools under agentWrite to a session an operator created, and never to a scoped principal', async () => {
    const harness = fakeHarness()
    const { base } = await fixture.startShellServer(harness, {
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite: 'gated' },
    })
    await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(toolNames(harness)).toEqual([
      'session_info',
      'set_status',
      'peers_list',
      'peers_peek',
      'peers_send',
      'shell_list',
      'shell_read',
      'shell_run',
      'shell_write',
      'shell_kill',
      'shell_request_write',
    ])

    const scoped = fakeHarness()
    const { base: scopedBase } = await fixture.startShellServer(scoped, {
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite: 'allow' },
    })
    await createSession(scopedBase, 'alice-a', { cwd: tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(scoped.captured.options).toBeDefined())
    expect(toolNames(scoped)).toEqual(['session_info', 'set_status', 'peers_list', 'peers_peek', 'peers_send', 'shell_list', 'shell_read'])
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
      sessions: { store: createFileSessionRecordStore({ dir: stateDir }) },
      parking: { parkDelayMs: 10 },
      shell: { enabled: true, artifactDir: fixture.tempDir(), agentWrite },
    })
    const harness = fakeHarness()
    const { base } = await fixture.startServer(harness, gateway('gated'))
    const id = await createSession(base, 'operator', { cwd: tempDir(), prompt: 'hi' })
    expect(built).toHaveLength(1)
    expect(built[0]!.config).toMatchObject({ createdByOperator: true, shellAgentWrite: 'gated' })
    expect(built[0]!.config.shells).toBeDefined()
    await vi.waitFor(async () => expect((await fileRuntimeStore(stateDir).get(id))?.kind).toBe('dormant'))
    const stored = (await fileRuntimeStore(stateDir).get(id))!
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
