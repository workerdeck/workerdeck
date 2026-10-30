import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ttyText, type Runner } from '@workerdeck/core'
import { SHELL_LINGER_MS, type SessionEvent, type SessionEventBody, type ShellInfo, type ShellOwner } from '@workerdeck/protocol'
import {
  clampSize,
  createShellRegistry,
  loadPty,
  loginShell,
  shellChildEnv,
  shellPermitted,
  type ShellRegistry,
  type StoredShellIndex,
} from '../src/services/shells.ts'
import { drainingPty } from '../src/services/shell-env.ts'
import { readProcessTable } from '../src/services/process-tree.ts'
import type { PtyChild, PtyModule } from '../src/services/shell-types.ts'
import { fakeRunner } from './helpers.ts'
import { ptySuite, registryFixture } from './shell-helpers.ts'

const withPty = ptySuite(await loadPty(), 'shells.test')

const { tempDir, makeRegistry, makeScripted, pty, signals, runner, cleanup } = registryFixture('wd-shells-')
afterEach(async () => {
  vi.useRealTimers()
  await cleanup()
})

const SESSION_INFO = { id: 's1', status: 'idle' as const, cwd: '/tmp', createdAt: 0, lastSeq: 0, pendingPermissionCount: 0 }

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

async function scripted(shells: ShellRegistry, owner: Runner, command: string, kind: ShellOwner = 'user') {
  const spawned = await shells.spawn({ runner: owner, command, owner: kind })
  return { ...spawned, child: pty.last() }
}

// A scripted shell that printed `chunks` and exited with `exitCode`, settled before it returns.
async function finished(shells: ShellRegistry, owner: Runner, chunks: string[], exitCode = 0) {
  const spawned = await scripted(shells, owner, 'scripted')
  for (const chunk of chunks) {
    spawned.child.emit(chunk)
  }
  spawned.child.exit(exitCode)
  return { ...spawned, shell: spawned.source.info() }
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
  // The file can exist before its pid is written to it.
  await vi.waitFor(() => expect(existsSync(file) && Number(readFileSync(file, 'utf8').trim())).toBeGreaterThan(1), { timeout: 4000 })
  const pid = Number(readFileSync(file, 'utf8').trim())
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

describe('records', () => {
  it('marks a shell that redraws as interactive, even across a split escape, and leaves plain output alone', async () => {
    const shells = makeScripted()
    const plain = await finished(shells, runner('s1'), ['one\r\x1b[Ktwo\r\n'])
    expect(plain.shell.interactive).toBeUndefined()
    const split = await scripted(shells, runner('s2'), 'progress')
    split.child.emit('a\r\n\x1b[')
    expect(split.source.info().interactive).toBeUndefined()
    split.child.emit('1Ab\r\n')
    expect(split.source.info().interactive).toBe(true)
  })

  it('labels by the first line of the command and numbers shells per session', async () => {
    const shells = makeScripted()
    const s1 = runner('s1')
    const first = await scripted(shells, s1, 'echo one\necho two')
    const second = await scripted(shells, s1, `echo ${'x'.repeat(200)}`)
    const other = await scripted(shells, runner('s2'), 'true')
    expect(first.shell.label).toBe('echo one')
    expect(second.shell.label).toBe(`echo ${'x'.repeat(75)}`)
    expect([first.shell.ordinal, second.shell.ordinal, other.shell.ordinal]).toEqual([1, 2, 1])
    expect(shells.list('s1').map((s) => s.ordinal)).toEqual([2, 1])
  })

  it('reports a non-zero exit and a signal death without an exit code', async () => {
    const shells = makeScripted()
    const failed = await finished(shells, runner('s1'), [], 3)
    expect(failed.shell).toMatchObject({ status: 'exited', exitCode: 3, endReason: 'exit' })
    const signalled = await scripted(shells, runner('s2'), 'kill -9 $$')
    signalled.child.exit(0, 9)
    expect(signalled.source.info().exitCode).toBeUndefined()
    expect(signalled.source.info()).toMatchObject({ status: 'exited', signal: 9, endReason: 'exit' })
  })

  it('refuses a cwd that is not a directory', async () => {
    const shells = makeScripted()
    await expect(shells.spawn({ runner: runner('s1', join(tempDir(), 'missing')), command: 'true', owner: 'user' })).rejects.toThrow(
      /not a directory/,
    )
    expect(shells.list('s1')).toEqual([])
    expect(pty.children).toEqual([])
  })

  it('caps running shells per session and gateway-wide', async () => {
    const shells = makeScripted({ maxRunningPerSession: 2, maxRunningTotal: 3 })
    const s1 = runner('s1')
    await scripted(shells, s1, 'sleep 30')
    const second = await scripted(shells, s1, 'sleep 30')
    await expect(shells.spawn({ runner: s1, command: 'true', owner: 'user' })).rejects.toThrow(/limit is 2/)
    await scripted(shells, runner('s2'), 'sleep 30')
    await expect(shells.spawn({ runner: runner('s3'), command: 'true', owner: 'user' })).rejects.toThrow(/limit is 3/)
    expect(pty.children).toHaveLength(3)
    shells.kill('s1', second.shell.id)
    const room = await finished(shells, s1, ['room\r\n'])
    expect(room.shell).toMatchObject({ exitCode: 0, endReason: 'exit' })
  })
})

describe('scripted kills', () => {
  it('honours a configured wall clock as a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const shells = makeScripted({ timeoutMs: 150 })
    const { source, child } = await scripted(shells, runner('s1'), 'sleep 30')
    vi.advanceTimersByTime(149)
    expect(source.info().status).toBe('running')
    expect(signals).toEqual([])
    vi.advanceTimersByTime(1)
    expect(source.info()).toMatchObject({ status: 'exited', endReason: 'timeout' })
    expect(signals).toEqual([{ pid: -child.pid, name: 'SIGKILL' }])
  })

  it("kills a session's shells when it closes or parks", async () => {
    const shells = makeScripted()
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

    const closed = await scripted(shells, watched, 'sleep 30')
    emit({ type: 'session_closed', reason: 'client' })
    expect(closed.source.info()).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(signals).toEqual([{ pid: -closed.child.pid, name: 'SIGKILL' }])

    const parked = await scripted(shells, watched, 'sleep 30')
    emit({ type: 'status_changed', status: 'parked' })
    expect(parked.source.info()).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(signals.at(-1)).toEqual({ pid: -parked.child.pid, name: 'SIGKILL' })
  })

  it('killAll settles every running shell as server_stopped and flush lands the index', async () => {
    const dir = tempDir()
    const shells = makeScripted({ artifactDir: dir })
    const { shell, child } = await scripted(shells, runner('s1'), 'sleep 30')
    const done = await finished(shells, runner('s2'), [])
    expect(shells.killAll('server_stopped')).toBe(1)
    expect(signals).toEqual([{ pid: -child.pid, name: 'SIGKILL' }])
    expect(shells.get('s1', shell.id)).toMatchObject({ status: 'exited', endReason: 'server_stopped' })
    expect(shells.get('s2', done.shell.id)).toMatchObject({ endReason: 'exit' })
    await shells.flush()
    expect(readIndex(dir, 's1').shells[0]).toMatchObject({
      id: shell.id,
      status: 'exited',
      endReason: 'server_stopped',
      generation: 'gen-a',
    })
    await expect(shells.spawn({ runner: runner('s3'), command: 'true', owner: 'user' })).rejects.toThrow(/shutting down/)
  })
})

describe('artifact', () => {
  it('keeps small output inline in the index and spills past the threshold', async () => {
    const dir = tempDir()
    const shells = makeScripted({ artifactDir: dir, spillBytes: 1024 })
    const small = await finished(shells, runner('s1'), ['sm', 'all'])
    const edge = await finished(shells, runner('s1'), ['e'.repeat(1000), 'e'.repeat(24)])
    const payload = 'a' + 'é'.repeat(512)
    const big = await finished(shells, runner('s1'), [payload.slice(0, 300), payload.slice(300)])
    await shells.flush()
    const index = readIndex(dir, 's1')
    expect(index).toMatchObject({ version: 1, sessionId: 's1', nextOrdinal: 4 })
    const record = (id: string) => index.shells.find((s) => s.id === id)!
    expect(record(small.shell.id)).toMatchObject({ output: 'small', bytes: 5 })
    expect(record(small.shell.id).artifact).toBeUndefined()
    expect(record(edge.shell.id)).toMatchObject({ output: 'e'.repeat(1024), bytes: 1024 })
    expect(record(edge.shell.id).artifact).toBeUndefined()
    expect(existsSync(join(dir, 's1', `${edge.shell.id}.raw`))).toBe(false)
    expect(record(big.shell.id)).toMatchObject({ artifact: `s1/${big.shell.id}.raw`, bytes: 1025 })
    expect(record(big.shell.id).output).toBeUndefined()
    const raw = join(dir, 's1', `${big.shell.id}.raw`)
    expect(readFileSync(raw)).toEqual(Buffer.from(payload, 'utf8'))
    expect(statSync(raw).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 's1')).mode & 0o777).toBe(0o700)
    await expect(shells.output('s1', big.shell.id, { view: 'raw' })).resolves.toBe(payload)
    await expect(shells.output('s1', big.shell.id, { view: 'text', tail: 10 })).resolves.toBe('é'.repeat(5))
    await expect(shells.output('s1', small.shell.id, { view: 'text' })).resolves.toBe('small')
    await expect(shells.output('s1', 'sh_nope', { view: 'text' })).resolves.toBeUndefined()
  })

  it('stops the file at the cap, marks the record, and keeps the tail ring moving', async () => {
    const dir = tempDir()
    const shells = makeScripted({ artifactDir: dir, spillBytes: 512, artifactMaxBytes: 2048, tailRingBytes: 256, tailFlushMs: 60_000 })
    const { shell, source } = await finished(shells, runner('s1'), ['a'.repeat(4095), 'a'.repeat(4097), '\r\n', 'END\r\n'])
    expect(shell).toMatchObject({ capped: true, exitCode: 0, bytes: 8192 + 2 + 5 })
    await shells.flush()
    const raw = join(dir, 's1', `${shell.id}.raw`)
    expect(statSync(raw).size).toBe(2048)
    await expect(shells.output('s1', shell.id, { view: 'raw' })).resolves.toBe('a'.repeat(2048))
    const tail = await shells.output('s1', shell.id, { view: 'raw', tail: 256 })
    expect(tail).toBe('a'.repeat(249) + '\r\nEND\r\n')
    expect(source.text()).toBe('a'.repeat(2048) + '\n' + 'a'.repeat(249) + '\nEND\n')
    expect(readFileSync(join(dir, 's1', `${shell.id}.tail.raw`)).toString('utf8')).toBe(tail)
  })

  it('caps at exactly the byte limit, cuts the file inside a straddling character, and keeps the text view whole', async () => {
    const dir = tempDir()
    const limits = { artifactDir: dir, spillBytes: 4, artifactMaxBytes: 11, tailRingBytes: 8, tailFlushMs: 60_000 }
    const shells = makeScripted(limits)
    const exact = await scripted(shells, runner('s1'), 'exact')
    exact.child.emit('0123456789a')
    expect(exact.source.info()).toMatchObject({ bytes: 11 })
    expect(exact.source.info().capped).toBeUndefined()
    exact.child.emit('é')
    expect(exact.source.info()).toMatchObject({ bytes: 13, capped: true })
    exact.child.emit('xyz')
    exact.child.exit(0)
    const straddled = await finished(shells, runner('s1'), ['0123456789', 'é!'])
    expect(straddled.shell).toMatchObject({ bytes: 13, capped: true })
    const gapped = await finished(shells, runner('s1'), ['0123456789a', 'bbbé', 'tuvwxyz'])
    await shells.flush()
    expect(readFileSync(join(dir, 's1', `${exact.shell.id}.raw`))).toEqual(Buffer.from('0123456789a'))
    expect(readFileSync(join(dir, 's1', `${straddled.shell.id}.raw`))).toEqual(Buffer.from([...Buffer.from('0123456789'), 0xc3]))
    await expect(shells.output('s1', exact.shell.id, { view: 'raw', tail: 8 })).resolves.toBe('89aéxyz')
    expect(readFileSync(join(dir, 's1', `${exact.shell.id}.tail.raw`))).toEqual(Buffer.from('89aéxyz'))
    expect(readFileSync(join(dir, 's1', `${gapped.shell.id}.tail.raw`))).toEqual(Buffer.from([0xa9, ...Buffer.from('tuvwxyz')]))
    const texts = ['0123456789aéxyz', '0123456789é!', '0123456789a\ntuvwxyz']
    expect([exact.source.text(), straddled.source.text(), gapped.source.text()]).toEqual(texts)

    const next = makeScripted({ ...limits, generation: 'gen-b' })
    await next.hydrate()
    const stored = await Promise.all([exact, straddled, gapped].map(({ shell }) => next.output('s1', shell.id, { view: 'text' })))
    expect(stored).toEqual(texts)
  })

  it('sweeps expired records and their files after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const dir = tempDir()
    const shells = makeScripted({ artifactDir: dir, spillBytes: 64, artifactTtlMs: 100 })
    const { shell } = await finished(shells, runner('s1'), ['b'.repeat(200)])
    const raw = join(dir, 's1', `${shell.id}.raw`)
    await shells.flush()
    expect(existsSync(raw)).toBe(true)
    vi.setSystemTime(1_000_099)
    await shells.sweep()
    expect(shells.get('s1', shell.id)).toBeDefined()
    vi.setSystemTime(1_000_100)
    await shells.sweep()
    await shells.flush()
    expect(shells.get('s1', shell.id)).toBeUndefined()
    expect(existsSync(raw)).toBe(false)
    expect(readIndex(dir, 's1')).toMatchObject({ nextOrdinal: 2, shells: [] })
  })
})

describe('index', () => {
  it('round-trips through the index and continues the ordinal in a new generation', async () => {
    const dir = tempDir()
    const first = makeScripted({ artifactDir: dir, spillBytes: 64 })
    const one = await finished(first, runner('s1'), ['one\r\n'])
    const two = await finished(first, runner('s1'), ['c'.repeat(100), 'c'.repeat(100)])
    await first.flush()

    const second = makeScripted({ artifactDir: dir, generation: 'gen-b' })
    await second.hydrate()
    expect(second.list('s1').map((s) => s.id)).toEqual([two.shell.id, one.shell.id])
    expect(second.get('s1', one.shell.id)).toMatchObject({ status: 'exited', exitCode: 0, endReason: 'exit', ordinal: 1 })
    await expect(second.output('s1', one.shell.id, { view: 'text' })).resolves.toBe('one\n')
    await expect(second.output('s1', two.shell.id, { view: 'raw' })).resolves.toBe('c'.repeat(200))
    await expect(second.output('s1', two.shell.id, { view: 'raw', tail: 5 })).resolves.toBe('ccccc')
    const attached = await second.attach('s1', two.shell.id, { write: () => {}, end: () => {} })
    expect(attached.scrollback).toBe('c'.repeat(200))
    const three = await finished(second, runner('s1'), ['three\r\n'])
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
      expect(shells.decorate(SESSION_INFO).shells).toBeUndefined()
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps the index in memory without an artifact dir and spills under the tmpdir', async () => {
    const shells = makeScripted({ artifactDir: null, spillBytes: 64 })
    const { shell } = await finished(shells, runner('s1'), ['d'.repeat(200)])
    await expect(shells.output('s1', shell.id, { view: 'raw' })).resolves.toBe('d'.repeat(200))
    await shells.hydrate()
    expect(shells.get('s1', shell.id)).toBeDefined()
  })
})

describe('source', () => {
  it('coalesces output notifications while running and fires synchronously on exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const shells = makeScripted()
    const { shell, source, child } = await scripted(shells, runner('s1'), 'ticks')
    const chunks: string[] = []
    await shells.attach('s1', shell.id, { write: (data) => chunks.push(data), end: () => {} })
    const seen: Array<{ status: string; text: string }> = []
    source.subscribe(() => seen.push({ status: source.info().status, text: source.text() }))
    const tick = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        child.emit(`${i}\r\n`)
      }
    }
    tick(0, 5)
    expect(chunks).toEqual(['0\r\n', '1\r\n', '2\r\n', '3\r\n', '4\r\n'])
    vi.advanceTimersByTime(249)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([{ status: 'running', text: '0\n1\n2\n3\n4\n' }])
    tick(5, 10)
    vi.advanceTimersByTime(250)
    const all = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n'
    expect(seen).toEqual([
      { status: 'running', text: '0\n1\n2\n3\n4\n' },
      { status: 'running', text: all },
    ])
    child.emit('end\r\n')
    child.exit(0)
    expect(seen.slice(2)).toEqual([{ status: 'exited', text: `${all}end\n` }])
    vi.advanceTimersByTime(1000)
    expect(seen).toHaveLength(3)
    expect(chunks).toHaveLength(11)
  })

  it('hands out the ttyText view of the raw bytes, cached between changes', async () => {
    const shells = makeScripted()
    const { shell, source } = await finished(shells, runner('s1'), ['a\x1b[1mb\x1b', '[0m\r\nprogress 1\rprogress 2\r\n'])
    const raw = await shells.output('s1', shell.id, { view: 'raw' })
    expect(raw).toBe('a\x1b[1mb\x1b[0m\r\nprogress 1\rprogress 2\r\n')
    expect(source.text()).toBe('ab\nprogress 2\n')
    expect(source.text()).toBe(ttyText(raw!))
    expect(source.text()).toBe(source.text())
  })
})

describe('decorate', () => {
  it('lists running shells and lingering non-zero exits on the session info', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(5_000_000)
    const shells = makeScripted()
    expect(shells.decorate(SESSION_INFO)).toBe(SESSION_INFO)
    const running = await scripted(shells, runner('s1'), 'sleep 30')
    const clean = await finished(shells, runner('s1'), [])
    const failed = await finished(shells, runner('s1'), [], 2)
    const ids = () =>
      shells
        .decorate(SESSION_INFO)
        .shells?.map((s) => s.id)
        .sort()
    expect(ids()).toEqual([running.shell.id, failed.shell.id].sort())
    expect(ids()).not.toContain(clean.shell.id)
    expect(shells.running().map((s) => s.id)).toEqual([running.shell.id])
    vi.setSystemTime(5_000_000 + SHELL_LINGER_MS - 1)
    expect(ids()).toEqual([running.shell.id, failed.shell.id].sort())
    vi.setSystemTime(5_000_000 + SHELL_LINGER_MS)
    expect(ids()).toEqual([running.shell.id])
    expect(SESSION_INFO).not.toHaveProperty('shells')
  })
})

describe('attach over a scripted PTY', () => {
  it('hands a failed replay to the caller and leaves no sink behind it', async () => {
    const dir = tempDir()
    const shells = makeScripted({ artifactDir: dir, spillBytes: 8 })
    const { shell, child } = await scripted(shells, runner('s1'), 'echo spilled; sleep 30')
    child.emit('spilled past the threshold\r\n')
    await shells.flush()
    const raw = join(dir, 's1', `${shell.id}.raw`)
    expect(existsSync(raw)).toBe(true)
    rmSync(raw)
    mkdirSync(raw)
    const doomed = await attachDoomed(shells, 's1', shell.id)
    await new Promise((resolve) => setImmediate(resolve))
    collectGarbage()
    expect(doomed.deref()).toBeUndefined()
    expect(shells.get('s1', shell.id)?.status).toBe('running')
  })

  it('carries input to the child, clamps a resize onto it, and refuses input once it exits', async () => {
    const shells = makeScripted()
    const { shell, child } = await scripted(shells, runner('s1'), 'read -r name')
    expect(shells.resize('s1', shell.id, { cols: 5000, rows: 0 })).toEqual({ cols: 1000, rows: 1 })
    expect(shells.resize('s1', shell.id, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
    expect(child.sizes).toEqual([
      [1000, 1],
      [80, 24],
    ])
    expect(shells.get('s1', shell.id)).toMatchObject({ cols: 80, rows: 24 })
    shells.write('s1', shell.id, 'bob\r')
    expect(child.writes).toEqual(['bob\r'])
    child.exit(0)
    expect(() => shells.write('s1', shell.id, 'more')).toThrow(/exited/)
    expect(shells.resize('s1', shell.id, { cols: 90, rows: 30 })).toEqual({ cols: 90, rows: 30 })
    expect(child.sizes).toHaveLength(2)
    expect(shells.get('s1', shell.id)).toMatchObject({ cols: 80, rows: 24 })
    expect(() => shells.write('s1', 'sh_nope', 'x')).toThrow(/unknown shell/)
  })
})

describe('drainingPty', () => {
  // The bytes node-pty never read sit in the master; a regular file stands in for it, read by the same readSync loop.
  it('reads what the master still holds before destroy, through the decoder that holds a split character', () => {
    const file = join(tempDir(), 'master')
    writeFileSync(file, Buffer.concat([Buffer.from([0xa9]), Buffer.from('tail €\r\n')]))
    const fd = openSync(file, 'r')
    try {
      const decoder = new StringDecoder('utf8')
      expect(decoder.write(Buffer.from([0x68, 0xc3]))).toBe('h')
      const emitted: Array<string | Buffer> = []
      const destroyed: unknown[][] = []
      const socket = {
        _handle: { fd },
        _readableState: { decoder },
        emit: (_event: 'data', data: string | Buffer) => emitted.push(data) > 0,
        destroy: (...args: unknown[]) => destroyed.push(args),
      }
      const child = { pid: 1, _socket: socket } as unknown as PtyChild
      const inner: PtyModule = { spawn: () => child }
      drainingPty(inner).spawn('/bin/sh', [], { name: 'x', cols: 1, rows: 1, cwd: '/', env: {} })
      socket.destroy('reason')
      expect(emitted).toEqual(['étail €\r\n'])
      expect(destroyed).toEqual([['reason']])
    } finally {
      closeSync(fd)
    }
  })
})

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
    expect(shell.bytes).toBe(Buffer.byteLength(`tty\r\n${cwd}\r\nxterm-256color\r\n`))
  })
})

withPty('kill', () => {
  it('reaches a grandchild through the process group and settles as killed with no exit code', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const marker = join(cwd, 'late')
    const pidFile = join(cwd, 'grandchild.pid')
    const { shell, source } = await shells.spawn({
      runner: runner('s1', cwd),
      command: `sh -c 'echo $$ > ${pidFile}; sleep 2; echo late > ${marker}' & sleep 30`,
      owner: 'user',
    })
    const grandchild = await pidFrom(pidFile)
    const fired = vi.fn()
    source.subscribe(fired)
    const killed = shells.kill('s1', shell.id)
    expect(killed).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(killed?.exitCode).toBeUndefined()
    expect(fired).toHaveBeenCalledTimes(1)
    // The shell that would write the marker is gone, so the marker can never appear.
    await gone(grandchild)
    expect(existsSync(marker)).toBe(false)
    expect(shells.kill('s1', shell.id)).toMatchObject({ endReason: 'killed' })
  })

  // The escapee's `sh` writes the marker itself after its sleep, so once that pid is gone the marker can never appear.
  it('reaches a grandchild that started its own session, which the group kill alone cannot', async () => {
    const shells = makeRegistry()
    const cwd = tempDir()
    const { command, marker, pidFile } = escapee(cwd)
    const { shell } = await shells.spawn({ runner: runner('s1', cwd), command, owner: 'user' })
    const child = await pidFrom(pidFile)
    expect(shells.kill('s1', shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    await gone(child)
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
    const groupedPid = join(cwd, 'grouped.pid')
    const grouped = await shells.spawn({
      runner: runner('s1', cwd),
      command: `sh -c 'echo $$ > ${groupedPid}; sleep 2; echo late > ${plain}' & sleep 30`,
      owner: 'user',
    })
    const groupedChild = await pidFrom(groupedPid)
    expect(shells.kill('s1', shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(shells.kill('s1', grouped.shell.id)).toMatchObject({ status: 'exited', endReason: 'killed' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/process table/) }), {
      op: 'kill',
      sessionId: 's1',
      shellId: shell.id,
    })
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 4000 })
    await gone(groupedChild)
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
})

withPty('drain', () => {
  // The stall outlasts the ~600ms macOS keeps a finished session leader's unread pty output, so a registry that
  // spawns the login shell directly loses every byte here, with exit code 0. The output must fit the tty buffer: a
  // larger one blocks the shell until the stall ends, and nothing is lost either way.
  it('keeps the output of a command that exits while the gateway is stalled', async () => {
    const shells = makeRegistry()
    const { source } = await shells.spawn({ runner: runner('s1'), command: 'for i in 1 2 3 4 5; do echo line$i; done', owner: 'user' })
    await new Promise((resolve) => setImmediate(resolve))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900)
    const shell = await settled(source)
    expect(shell).toMatchObject({ status: 'exited', exitCode: 0, endReason: 'exit' })
    expect(source.text()).toBe('line1\nline2\nline3\nline4\nline5\n')
  })

  // Past the 4095 bytes one master read returns, so the record is several PTY chunks and every one must land.
  it('keeps every byte of a large output and its exact ending', async () => {
    const shells = makeRegistry()
    const { shell, source } = await run(shells, runner('s1'), 'head -c 8192 /dev/zero | tr "\\0" a; echo; echo END')
    expect(shell).toMatchObject({ status: 'exited', exitCode: 0, endReason: 'exit', bytes: 8199 })
    expect(source.text()).toBe(`${'a'.repeat(8192)}\nEND\n`)
    await expect(shells.output('s1', shell.id, { view: 'raw', tail: 16 })).resolves.toBe(`${'a'.repeat(9)}\r\nEND\r\n`)
  })

  // A grandchild that writes after the shell exits lands its bytes in the master after node-pty armed its 200ms destroy;
  // the stall makes that timer run before any read, the loaded-CI ordering that cut records to 4095 bytes. Linux only:
  // macOS revokes the tty at the leader's exit, so there the kernel has already discarded the late bytes.
  it.runIf(process.platform === 'linux')(
    'keeps output that reaches the master after the exit while the loop stalls past the destroy deadline',
    async () => {
      const shells = makeRegistry()
      const realSetTimeout = globalThis.setTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        if (ms === 200) {
          setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600))
        }
        return realSetTimeout(fn, ms)
      }) as typeof setTimeout)
      try {
        const command = `trap '' HUP; (sleep 0.2; head -c 8199 /dev/zero | tr '\\0' a) & exit 0`
        const { shell, source } = await run(shells, runner('s1'), command)
        expect(shell).toMatchObject({ status: 'exited', exitCode: 0, bytes: 8199 })
        expect(source.text()).toBe('a'.repeat(8199))
      } finally {
        vi.mocked(globalThis.setTimeout).mockRestore()
      }
    },
  )
})

withPty('attach', () => {
  // `read` holds the second line until the attach is live; with echo off the keystroke itself prints nothing.
  it('replays what came before, streams what comes after, and ends with the shell', async () => {
    const shells = makeRegistry()
    const { shell, source } = await shells.spawn({
      runner: runner('s1'),
      command: 'stty -echo; echo first; read -r go; echo second',
      owner: 'user',
    })
    await vi.waitFor(() => expect(source.text()).toBe('first\n'))
    const got: string[] = []
    const ended: string[] = []
    const attached = await shells.attach('s1', shell.id, { write: (d) => got.push(d), end: (r) => ended.push(r) })
    expect(attached.scrollback).toBe('first\r\n')
    expect(attached.shell.status).toBe('running')
    shells.write('s1', shell.id, 'go\r')
    await settled(source)
    expect(got.join('')).toBe('second\r\n')
    expect(ended).toEqual(['exit'])
    const late = await shells.attach('s1', shell.id, { write: () => {}, end: () => {} })
    expect(late.scrollback).toBe('first\r\nsecond\r\n')
    expect(late.shell.status).toBe('exited')
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

  it('shellChildEnv never passes the gateway key on', () => {
    expect(shellChildEnv({ A: '1', WORKERDECK_AUTH_KEY: 'gateway-secret', WORKERDECK_TOKEN: 't' })).toEqual({ A: '1' })
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
