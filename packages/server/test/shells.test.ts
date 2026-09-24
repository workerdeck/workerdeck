import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ttyText, type Runner } from '@workerdeck/core'
import type { SessionEvent, SessionEventBody, ShellInfo } from '@workerdeck/protocol'
import {
  clampSize,
  createShellRegistry,
  loadPty,
  loginShell,
  shellChildEnv,
  shellPermitted,
  type ShellRegistry,
  type ShellRegistryOptions,
  type StoredShellIndex,
} from '../src/services/shells.ts'
import { readProcessTable } from '../src/services/process-tree.ts'
import { fakeRunner } from './helpers.ts'

const pty = await loadPty()
if (pty === null) {
  console.warn('shells.test: @lydell/node-pty is not installed for this platform, skipping the PTY suites')
}
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wd-shells-')))
  dirs.push(dir)
  return dir
}

function makeRegistry(overrides: Partial<ShellRegistryOptions> = {}): ShellRegistry {
  const created = createShellRegistry({ generation: 'gen-a', artifactDir: tempDir(), ...overrides })
  registries.push(created)
  return created
}

function runner(id: string, cwd = tempDir()): Runner {
  return fakeRunner(id, { cwd })
}

function settled(source: { info: () => ShellInfo; subscribe: (l: () => void) => () => void }): Promise<ShellInfo> {
  return new Promise((resolve) => {
    if (source.info().status !== 'running') {
      resolve(source.info())
      return
    }
    const off = source.subscribe(() => {
      if (source.info().status !== 'running') {
        off()
        resolve(source.info())
      }
    })
  })
}

async function run(shells: ShellRegistry, owner: Runner, command: string) {
  const spawned = await shells.spawn({ runner: owner, command, owner: 'user' })
  const shell = await settled(spawned.source)
  return { ...spawned, shell }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readIndex(dir: string, sessionId: string): StoredShellIndex {
  return JSON.parse(readFileSync(join(dir, `${encodeURIComponent(sessionId)}.json`), 'utf8')) as StoredShellIndex
}

// The shape `$ box dev` had: a supervisor (node) whose child starts its own session, so the group kill reaches the
// supervisor and never the child. `pidFile` names the child, `marker` appears only if it lives to write it.
function escapee(cwd: string): { command: string; marker: string; pidFile: string } {
  const marker = join(cwd, 'late')
  const pidFile = join(cwd, 'escapee.pid')
  const script = join(cwd, 'escapee.cjs')
  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const child = spawn('sh', ['-c', 'sleep 0.6; echo late > ${JSON.stringify(marker)}'], { detached: true, stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setTimeout(() => {}, 30000)',
    ].join('\n'),
  )
  return { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, marker, pidFile }
}

async function pidFrom(file: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 4000 })
  const pid = Number(readFileSync(file, 'utf8').trim())
  expect(pid).toBeGreaterThan(1)
  expect(() => process.kill(pid, 0)).not.toThrow()
  return pid
}

function gone(pid: number): Promise<void> {
  return vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 4000 })
}

function collectGarbage(): void {
  setFlagsFromString('--expose-gc')
  ;(runInNewContext('gc') as () => void)()
}

// The sink lives only in this frame, so once the attach has failed nothing but a leaked proxy could keep it reachable.
async function attachDoomed(shells: ShellRegistry, sessionId: string, shellId: string): Promise<WeakRef<object>> {
  const sink = { write: () => {}, end: () => {} }
  await expect(shells.attach(sessionId, shellId, sink)).rejects.toThrow(/EISDIR/)
  return new WeakRef(sink)
}

withPty('spawn', () => {
  it('runs the command in a PTY, in the cwd, and records a clean exit', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const { shell, source } = await run(shells, runner('s1', cwd), '[ -t 0 ] && echo tty || echo pipe; pwd; echo "$TERM"')
    expect(shell.id).toMatch(/^sh_[a-z2-7]{12}$/)
    expect(shell).toMatchObject({
      sessionId: 's1',
      ordinal: 1,
      owner: 'user',
      status: 'exited',
      endReason: 'exit',
      exitCode: 0,
      cwd,
      cols: 120,
      rows: 40,
    })
    expect(shell.signal).toBeUndefined()
    expect(source.text()).toBe(`tty\n${cwd}\nxterm-256color\n`)
    expect(shell.bytes).toBeGreaterThan(0)
  })

  it('marks a shell that redraws as interactive, even across a split escape, and leaves plain output alone', async () => {
    const shells = makeRegistry()
    const plain = await run(shells, runner('s1'), "printf 'one\\r\\033[Ktwo\\n'")
    expect(plain.shell.interactive).toBeUndefined()
    const split = await run(shells, runner('s2'), "printf 'a\\n\\033['; sleep 0.2; printf '1Ab\\n'")
    expect(split.shell.interactive).toBe(true)
  })

  it('labels by the first line of the command and numbers shells per session', async () => {
    const shells = makeRegistry()
    const s1 = runner('s1')
    const first = await run(shells, s1, 'echo one\necho two')
    const second = await run(shells, s1, `echo ${'x'.repeat(200)}`)
    const other = await run(shells, runner('s2'), 'true')
    expect(first.shell.label).toBe('echo one')
    expect(second.shell.label).toHaveLength(80)
    expect([first.shell.ordinal, second.shell.ordinal, other.shell.ordinal]).toEqual([1, 2, 1])
    expect(shells.list('s1').map((s) => s.ordinal)).toEqual([2, 1])
  })

  it('reports a non-zero exit and a signal death without an exit code', async () => {
    const shells = makeRegistry()
    const failed = await run(shells, runner('s1'), 'exit 3')
    expect(failed.shell).toMatchObject({ exitCode: 3, endReason: 'exit' })
    const signalled = await run(shells, runner('s2'), 'kill -9 $$')
    expect(signalled.shell.exitCode).toBeUndefined()
    expect(signalled.shell).toMatchObject({ signal: 9, endReason: 'exit' })
  })

  it('refuses a cwd that is not a directory', async () => {
    const shells = makeRegistry()
    await expect(shells.spawn({ runner: runner('s1', join(tempDir(), 'missing')), command: 'true', owner: 'user' })).rejects.toThrow(
      /not a directory/,
    )
    expect(shells.list('s1')).toEqual([])
  })
})

withPty('kill', () => {
  it('reaches a grandchild through the process group and settles as killed with no exit code', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const marker = join(cwd, 'late')
    const { shell, source } = await shells.spawn({
      runner: runner('s1', cwd),
      command: `(sleep 0.6; echo late > ${marker}) & sleep 30`,
      owner: 'user',
    })
    await sleep(100)
    const fired = vi.fn()
    source.subscribe(fired)
    const killed = shells.kill('s1', shell.id)
    expect(killed).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(killed?.exitCode).toBeUndefined()
    expect(fired).toHaveBeenCalledTimes(1)
    await sleep(900)
    expect(existsSync(marker)).toBe(false)
    expect(shells.kill('s1', shell.id)).toMatchObject({ endReason: 'killed' })
  })

  it('reaches a grandchild that started its own session, which the group kill alone cannot', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const { command, marker, pidFile } = escapee(cwd)
    const { shell } = await shells.spawn({ runner: runner('s1', cwd), command, owner: 'user' })
    const child = await pidFrom(pidFile)
    expect(shells.kill('s1', shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    await gone(child)
    await sleep(800)
    expect(existsSync(marker)).toBe(false)
  })

  it('degrades to the group kill without a process table, keeps the record honest, and says so', async () => {
    const onError = vi.fn()
    const shells = makeRegistry({ processTable: () => null, onError })
    const cwd = tempDir()
    const { command, marker, pidFile } = escapee(cwd)
    const { shell } = await shells.spawn({ runner: runner('s1', cwd), command, owner: 'user' })
    await pidFrom(pidFile)
    const plain = join(cwd, 'plain')
    const grouped = await shells.spawn({
      runner: runner('s1', cwd),
      command: `(sleep 0.6; echo late > ${plain}) & sleep 30`,
      owner: 'user',
    })
    await sleep(100)
    expect(shells.kill('s1', shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(shells.kill('s1', grouped.shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/process table/) }), {
      op: 'kill',
      sessionId: 's1',
      shellId: shell.id,
    })
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 4000 })
    expect(existsSync(plain)).toBe(false)
  })

  it('killAllSync reaches the same escapee on the force path', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const { command, marker, pidFile } = escapee(cwd)
    await shells.spawn({ runner: runner('s1', cwd), command, owner: 'user' })
    const child = await pidFrom(pidFile)
    shells.killAllSync()
    await gone(child)
    await sleep(800)
    expect(existsSync(marker)).toBe(false)
  })

  it('sees the PTY child as its own direct child leading its own group, which the recycled-pid guard rests on', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const pidFile = join(cwd, 'pid')
    await shells.spawn({ runner: runner('s1', cwd), command: `echo $$ > ${pidFile}; exec sleep 30`, owner: 'user' })
    const pid = await pidFrom(pidFile)
    const table = readProcessTable()
    expect(table).not.toBeNull()
    expect(table!.find((row) => row.pid === pid)).toEqual({ pid, ppid: process.pid, pgid: pid })
    expect(table!.find((row) => row.pid === process.pid)?.pgid).not.toBe(pid)
  })

  it('honours a configured wall clock as a timeout', async () => {
    const shells = makeRegistry({ timeoutMs: 150 })
    const started = Date.now()
    const { shell } = await run(shells, runner('s1'), 'sleep 30')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(shell).toMatchObject({ endReason: 'timeout' })
  })

  it("kills a session's shells when it closes or parks", async () => {
    const shells = makeRegistry()
    let listener: ((event: SessionEvent) => void) | undefined
    let seq = 0
    const watched = {
      ...runner('s1'),
      subscribe: (fn: (event: SessionEvent) => void) => {
        listener = fn
        return () => {}
      },
    }
    const emit = (body: SessionEventBody) => listener!({ ...body, seq: ++seq, ts: Date.now() } as SessionEvent)
    shells.watch(watched)

    const closed = await shells.spawn({ runner: watched, command: 'sleep 30', owner: 'user' })
    emit({ type: 'session_closed', reason: 'client' })
    expect(closed.source.info()).toMatchObject({ status: 'exited', endReason: 'killed' })

    const parked = await shells.spawn({ runner: watched, command: 'sleep 30', owner: 'user' })
    emit({ type: 'status_changed', status: 'parked' })
    expect(parked.source.info()).toMatchObject({ status: 'exited', endReason: 'killed' })
  })

  it('killAll settles every running shell as server_stopped and flush lands the index', async () => {
    const dir = tempDir()
    const shells = makeRegistry({ artifactDir: dir })
    const cwd = tempDir()
    const pidFile = join(cwd, 'pid')
    const { shell } = await shells.spawn({ runner: runner('s1', cwd), command: `echo $$ > ${pidFile}; exec sleep 30`, owner: 'user' })
    const done = await run(shells, runner('s2'), 'true')
    await sleep(150)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(shells.killAll('server_stopped')).toBe(1)
    expect(shells.get('s1', shell.id)).toMatchObject({ status: 'exited', endReason: 'server_stopped' })
    expect(shells.get('s2', done.shell.id)).toMatchObject({ endReason: 'exit' })
    await shells.flush()
    expect(readIndex(dir, 's1').shells[0]).toMatchObject({
      id: shell.id,
      status: 'exited',
      endReason: 'server_stopped',
      generation: 'gen-a',
    })
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0)
        await sleep(50)
      } catch {
        break
      }
    }
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(shells.spawn({ runner: runner('s3'), command: 'true', owner: 'user' })).rejects.toThrow(/shutting down/)
  })
})

withPty('limits', () => {
  it('caps running shells per session and gateway-wide', async () => {
    const shells = makeRegistry({ maxRunningPerSession: 2, maxRunningTotal: 3 })
    const s1 = runner('s1')
    await shells.spawn({ runner: s1, command: 'sleep 30', owner: 'user' })
    const second = await shells.spawn({ runner: s1, command: 'sleep 30', owner: 'user' })
    await expect(shells.spawn({ runner: s1, command: 'true', owner: 'user' })).rejects.toThrow(/limit is 2/)
    await shells.spawn({ runner: runner('s2'), command: 'sleep 30', owner: 'user' })
    await expect(shells.spawn({ runner: runner('s3'), command: 'true', owner: 'user' })).rejects.toThrow(/limit is 3/)
    shells.kill('s1', second.shell.id)
    await expect(run(shells, s1, 'echo room')).resolves.toMatchObject({ shell: { exitCode: 0 } })
  })
})

withPty('artifact', () => {
  it('keeps small output inline in the index and spills past the threshold', async () => {
    const dir = tempDir()
    const shells = makeRegistry({ artifactDir: dir, spillBytes: 1024 })
    const small = await run(shells, runner('s1'), 'printf small')
    const big = await run(shells, runner('s1'), 'head -c 4096 /dev/zero | tr "\\0" a')
    await shells.flush()
    const index = readIndex(dir, 's1')
    expect(index).toMatchObject({ version: 1, sessionId: 's1', nextOrdinal: 3 })
    const [bigRecord, smallRecord] = [index.shells.find((s) => s.id === big.shell.id)!, index.shells.find((s) => s.id === small.shell.id)!]
    expect(smallRecord).toMatchObject({ output: 'small', bytes: 5 })
    expect(smallRecord.artifact).toBeUndefined()
    expect(bigRecord).toMatchObject({ artifact: `s1/${big.shell.id}.raw`, bytes: 4096 })
    expect(bigRecord.output).toBeUndefined()
    const raw = join(dir, 's1', `${big.shell.id}.raw`)
    expect(statSync(raw).size).toBe(4096)
    expect(statSync(raw).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 's1')).mode & 0o777).toBe(0o700)
    await expect(shells.output('s1', big.shell.id, { view: 'raw' })).resolves.toBe('a'.repeat(4096))
    await expect(shells.output('s1', big.shell.id, { view: 'text', tail: 10 })).resolves.toBe('a'.repeat(10))
    await expect(shells.output('s1', small.shell.id, { view: 'text' })).resolves.toBe('small')
    await expect(shells.output('s1', 'sh_nope', { view: 'text' })).resolves.toBeUndefined()
  })

  it('stops the file at the cap, marks the record, and keeps the tail ring moving', async () => {
    const dir = tempDir()
    const shells = makeRegistry({ artifactDir: dir, spillBytes: 512, artifactMaxBytes: 2048, tailRingBytes: 256, tailFlushMs: 60_000 })
    const { shell, source } = await run(shells, runner('s1'), 'head -c 8192 /dev/zero | tr "\\0" a; echo; echo END')
    expect(shell).toMatchObject({ capped: true, exitCode: 0, bytes: 8192 + 2 + 5 })
    const raw = join(dir, 's1', `${shell.id}.raw`)
    expect(statSync(raw).size).toBe(2048)
    await expect(shells.output('s1', shell.id, { view: 'raw' })).resolves.toBe('a'.repeat(2048))
    const tail = await shells.output('s1', shell.id, { view: 'raw', tail: 256 })
    expect(tail).toHaveLength(256)
    expect(tail!.endsWith('\r\nEND\r\n')).toBe(true)
    expect(source.text().endsWith('\nEND\n')).toBe(true)
    await shells.flush()
    expect(statSync(join(dir, 's1', `${shell.id}.tail.raw`)).size).toBe(256)
  })

  it('sweeps expired records and their files after the TTL', async () => {
    const dir = tempDir()
    const shells = makeRegistry({ artifactDir: dir, spillBytes: 64, artifactTtlMs: 100 })
    const { shell } = await run(shells, runner('s1'), 'head -c 200 /dev/zero | tr "\\0" b')
    const raw = join(dir, 's1', `${shell.id}.raw`)
    await shells.flush()
    expect(existsSync(raw)).toBe(true)
    await shells.sweep()
    expect(shells.get('s1', shell.id)).toBeDefined()
    await sleep(120)
    await shells.sweep()
    await shells.flush()
    expect(shells.get('s1', shell.id)).toBeUndefined()
    expect(existsSync(raw)).toBe(false)
    expect(readIndex(dir, 's1')).toMatchObject({ nextOrdinal: 2, shells: [] })
  })
})

withPty('index', () => {
  it('round-trips through the index and continues the ordinal in a new generation', async () => {
    const dir = tempDir()
    const first = makeRegistry({ artifactDir: dir, spillBytes: 64 })
    const one = await run(first, runner('s1'), 'echo one')
    const two = await run(first, runner('s1'), 'head -c 200 /dev/zero | tr "\\0" c')
    await first.flush()

    const second = makeRegistry({ artifactDir: dir, generation: 'gen-b' })
    await second.hydrate()
    expect(second.list('s1').map((s) => s.id)).toEqual([two.shell.id, one.shell.id])
    expect(second.get('s1', one.shell.id)).toMatchObject({ status: 'exited', exitCode: 0, endReason: 'exit', ordinal: 1 })
    await expect(second.output('s1', one.shell.id, { view: 'text' })).resolves.toBe('one\n')
    await expect(second.output('s1', two.shell.id, { view: 'raw' })).resolves.toBe('c'.repeat(200))
    await expect(second.output('s1', two.shell.id, { view: 'raw', tail: 5 })).resolves.toBe('ccccc')
    const attached = await second.attach('s1', two.shell.id, { write: () => {}, end: () => {} })
    expect(attached.scrollback).toBe('c'.repeat(200))
    const three = await run(second, runner('s1'), 'echo three')
    expect(three.shell.ordinal).toBe(3)
    await second.flush()
    expect(
      readIndex(dir, 's1')
        .shells.map((s) => s.generation)
        .sort(),
    ).toEqual(['gen-a', 'gen-a', 'gen-b'])
  })

  it('reconciles a running record from another generation without touching its pid', async () => {
    const dir = tempDir()
    const stale: StoredShellIndex = {
      version: 1,
      sessionId: 's1',
      nextOrdinal: 4,
      shells: [
        {
          id: 'sh_abcdefghijkl',
          sessionId: 's1',
          ordinal: 3,
          command: 'npm run dev',
          label: 'npm run dev',
          cwd: '/tmp',
          owner: 'user',
          status: 'running',
          startedAt: 1000,
          bytes: 12,
          cols: 120,
          rows: 40,
          generation: 'gen-old',
          output: 'listening\r\n',
        },
      ],
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's1.json'), JSON.stringify(stale))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const shells = makeRegistry({ artifactDir: dir, generation: 'gen-new' })
      await shells.hydrate()
      const record = shells.get('s1', 'sh_abcdefghijkl')
      expect(record).toMatchObject({ status: 'exited', endReason: 'server_restarted', ordinal: 3 })
      expect(record?.exitCode).toBeUndefined()
      expect(record?.endedAt).toBeGreaterThan(1000)
      expect(kill).not.toHaveBeenCalled()
      await expect(shells.output('s1', 'sh_abcdefghijkl', { view: 'text' })).resolves.toBe('listening\n')
      await shells.flush()
      expect(readIndex(dir, 's1').shells[0]).toMatchObject({ endReason: 'server_restarted', generation: 'gen-old' })
      // Not on the card. The record is `exited` from this gateway's point of view, it carries no exit code to call a
      // failure, and the pid on it is unkillable by rule (it may have been recycled), so a row would promise an action
      // no client can take. The transcript row is where "may still be running" belongs.
      expect(
        shells.decorate({ id: 's1', status: 'idle', cwd: '/tmp', createdAt: 0, lastSeq: 0, pendingPermissionCount: 0 }).shells,
      ).toBeUndefined()
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps the index in memory without an artifact dir and spills under the tmpdir', async () => {
    const shells = makeRegistry({ artifactDir: null, spillBytes: 64 })
    const { shell } = await run(shells, runner('s1'), 'head -c 200 /dev/zero | tr "\\0" d')
    await expect(shells.output('s1', shell.id, { view: 'raw' })).resolves.toBe('d'.repeat(200))
    await shells.hydrate()
    expect(shells.get('s1', shell.id)).toBeDefined()
  })
})

withPty('source', () => {
  it('coalesces output notifications while running and fires synchronously on exit', async () => {
    const shells = makeRegistry()
    const { source } = await shells.spawn({
      runner: runner('s1'),
      command: 'for i in 1 2 3 4 5; do echo $i; sleep 0.02; done; sleep 0.45',
      owner: 'user',
    })
    const seen: Array<{ status: string; text: string }> = []
    source.subscribe(() => seen.push({ status: source.info().status, text: source.text() }))
    await settled(source)
    const whileRunning = seen.filter((s) => s.status === 'running')
    expect(whileRunning.length).toBeGreaterThanOrEqual(1)
    expect(whileRunning.length).toBeLessThanOrEqual(2)
    expect(whileRunning.at(-1)?.text).toBe('1\n2\n3\n4\n5\n')
    expect(seen.at(-1)).toEqual({ status: 'exited', text: '1\n2\n3\n4\n5\n' })
  })

  it('hands out the ttyText view of the raw bytes, cached between changes', async () => {
    const shells = makeRegistry()
    const { shell, source } = await run(shells, runner('s1'), "printf 'a\\033[1mb\\033[0m\\nprogress 1\\rprogress 2\\n'")
    const raw = await shells.output('s1', shell.id, { view: 'raw' })
    expect(raw).toBe('a\x1b[1mb\x1b[0m\r\nprogress 1\rprogress 2\r\n')
    expect(source.text()).toBe('ab\nprogress 2\n')
    expect(source.text()).toBe(ttyText(raw!))
    expect(source.text()).toBe(source.text())
  })
})

withPty('drain', () => {
  // The stall outlasts the ~600ms macOS keeps a finished session leader's unread pty output, so a registry that
  // spawns the login shell directly loses every byte here, with exit code 0.
  it('keeps the output of a command that exits while the gateway is stalled', async () => {
    const shells = makeRegistry()
    const { source } = await shells.spawn({ runner: runner('s1'), command: 'for i in 1 2 3 4 5; do echo line$i; done', owner: 'user' })
    await new Promise((resolve) => setImmediate(resolve))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900)
    const shell = await settled(source)
    expect(shell).toMatchObject({ status: 'exited', exitCode: 0, endReason: 'exit' })
    expect(source.text()).toBe('line1\nline2\nline3\nline4\nline5\n')
  })
})

withPty('attach', () => {
  it('replays what came before, streams what comes after, and ends with the shell', async () => {
    const shells = makeRegistry()
    const { shell, source } = await shells.spawn({ runner: runner('s1'), command: 'echo first; sleep 0.3; echo second', owner: 'user' })
    await sleep(120)
    const got: string[] = []
    const ended: string[] = []
    const attached = await shells.attach('s1', shell.id, { write: (d) => got.push(d), end: (r) => ended.push(r) })
    expect(attached.scrollback).toBe('first\r\n')
    expect(attached.shell.status).toBe('running')
    await settled(source)
    expect(got.join('')).toBe('second\r\n')
    expect(ended).toEqual(['exit'])
    const late = await shells.attach('s1', shell.id, { write: () => {}, end: () => {} })
    expect(late.scrollback).toBe('first\r\nsecond\r\n')
    expect(late.shell.status).toBe('exited')
  })

  it('hands a failed replay to the caller and leaves no sink behind it', async () => {
    const dir = tempDir()
    const shells = makeRegistry({ artifactDir: dir, spillBytes: 8 })
    const { shell } = await shells.spawn({ runner: runner('s1'), command: 'echo spilled past the threshold; sleep 30', owner: 'user' })
    const raw = join(dir, 's1', `${shell.id}.raw`)
    await vi.waitFor(() => expect(existsSync(raw)).toBe(true))
    await shells.flush()
    rmSync(raw)
    mkdirSync(raw)
    const doomed = await attachDoomed(shells, 's1', shell.id)
    await sleep(0)
    collectGarbage()
    expect(doomed.deref()).toBeUndefined()
    expect(shells.get('s1', shell.id)?.status).toBe('running')
  })

  it('writes input to the PTY and applies a clamped resize', async () => {
    const shells = makeRegistry()
    const { shell, source } = await shells.spawn({
      runner: runner('s1'),
      command: 'read -r name; echo "hi $name"; sleep 0.2; stty size',
      owner: 'user',
    })
    expect(shells.resize('s1', shell.id, { cols: 5000, rows: 0 })).toEqual({ cols: 1000, rows: 1 })
    expect(shells.resize('s1', shell.id, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
    expect(shells.get('s1', shell.id)).toMatchObject({ cols: 80, rows: 24 })
    shells.write('s1', shell.id, 'bob\r')
    await settled(source)
    expect(source.text()).toContain('hi bob\n')
    expect(source.text()).toContain('24 80\n')
    expect(() => shells.write('s1', shell.id, 'more')).toThrow(/exited/)
    expect(() => shells.write('s1', 'sh_nope', 'x')).toThrow(/unknown shell/)
  })
})

withPty('decorate', () => {
  it('lists running shells and lingering non-zero exits on the session info', async () => {
    const shells = makeRegistry()
    const info = { id: 's1', status: 'idle' as const, cwd: '/tmp', createdAt: 0, lastSeq: 0, pendingPermissionCount: 0 }
    expect(shells.decorate(info)).toBe(info)
    const running = await shells.spawn({ runner: runner('s1'), command: 'sleep 30', owner: 'user' })
    const clean = await run(shells, runner('s1'), 'true')
    const failed = await run(shells, runner('s1'), 'exit 2')
    expect(
      shells
        .decorate(info)
        .shells?.map((s) => s.id)
        .sort(),
    ).toEqual([running.shell.id, failed.shell.id].sort())
    expect(shells.decorate(info).shells?.some((s) => s.id === clean.shell.id)).toBe(false)
    expect(shells.running().map((s) => s.id)).toEqual([running.shell.id])
    expect(info).not.toHaveProperty('shells')
  })
})

describe('shellPermitted', () => {
  const claude = {
    ...fakeRunner('c', { cwd: '/tmp' }),
    info: () => ({ ...fakeRunner('c', { cwd: '/tmp' }).info(), engine: 'claude' as const }),
  }
  const provider = { ...fakeRunner('p', {}), info: () => ({ ...fakeRunner('p', {}).info(), engine: 'provider' as const }) }

  it('needs the registry, the operator and a host cwd, all three', () => {
    const shells = createShellRegistry({ generation: 'g', artifactDir: null })
    expect(shellPermitted(shells, claude, true)).toBe(true)
    expect(shellPermitted(null, claude, true)).toBe(false)
    expect(shellPermitted(shells, claude, false)).toBe(false)
    expect(shellPermitted(shells, provider, true)).toBe(false)
    expect(shellPermitted(shells, fakeRunner('anon', { cwd: '/tmp' }), true)).toBe(false)
  })
})

describe('helpers', () => {
  it('shellChildEnv copies only defined entries', () => {
    expect(shellChildEnv({ A: '1', B: undefined })).toEqual({ A: '1' })
  })

  it('clampSize bounds and truncates', () => {
    expect(clampSize({ cols: 0, rows: 9999 })).toEqual({ cols: 1, rows: 500 })
    expect(clampSize({ cols: 80.9, rows: Number.NaN })).toEqual({ cols: 80, rows: 1 })
  })

  it('loginShell falls back to /bin/sh for a relative or missing SHELL', () => {
    expect(loginShell({ SHELL: '/bin/zsh' })).toBe('/bin/zsh')
    expect(loginShell({ SHELL: 'zsh' })).toBe('/bin/sh')
    expect(loginShell({})).toBe('/bin/sh')
  })
})
