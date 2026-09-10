import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { createShellService, shellChildEnv, shellPermitted, spawnShell } from '../src/services/shell.ts'
import { fakeRunner } from './helpers.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wd-shell-')))
  dirs.push(dir)
  return dir
}

function run(command: string, overrides: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return spawnShell({
    command,
    cwd: overrides.cwd ?? tempDir(),
    env: shellChildEnv(process.env),
    timeoutMs: overrides.timeoutMs ?? 5000,
    maxOutputBytes: overrides.maxOutputBytes ?? 64 * 1024,
  }).result
}

describe('spawnShell', () => {
  it('runs in the given cwd with a complete env and separates the streams', async () => {
    const cwd = tempDir()
    const result = await run('pwd; echo "$PWD"; echo warn >&2; exit 3', { cwd })
    expect(result.stdout).toBe(`${cwd}\n${cwd}\n`)
    expect(result.stderr).toBe('warn\n')
    expect(result.exitCode).toBe(3)
    expect(result.command).toBe('pwd; echo "$PWD"; echo warn >&2; exit 3')
  })

  it('reports a spawn failure as exit 127 with the reason on stderr', async () => {
    const result = await run('echo never', { cwd: join(tempDir(), 'missing') })
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toMatch(/ENOENT/)
    expect(result.stdout).toBe('')
  })

  it('caps captured output across both streams and says how much it dropped', async () => {
    const result = await run('head -c 300 /dev/zero | tr "\\0" a; head -c 300 /dev/zero | tr "\\0" b >&2', { maxOutputBytes: 100 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.replace(/\n\[output truncated: \d+ more bytes dropped\]$/, '').length).toBeLessThanOrEqual(100)
    expect(result.stdout).toMatch(/\[output truncated: 200 more bytes dropped\]$/)
    expect(result.stderr).toMatch(/\[output truncated: 300 more bytes dropped\]$/)
  })

  it('kills the whole process group on timeout, grandchildren included', async () => {
    const cwd = tempDir()
    const marker = join(cwd, 'late')
    const started = Date.now()
    const result = await run(`(sleep 0.6; echo late > ${marker}) & sleep 30`, { cwd, timeoutMs: 150 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.exitCode).toBe(124)
    expect(result.stderr).toMatch(/\[killed: timed out after 0s\]$/)
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(existsSync(marker)).toBe(false)
  })

  it('kill() settles once and later exit events do not re-settle', async () => {
    const child = spawnShell({
      command: 'sleep 30',
      cwd: tempDir(),
      env: shellChildEnv(process.env),
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    })
    child.kill('session closed')
    child.kill('again')
    const result = await child.result
    expect(result.exitCode).toBe(137)
    expect(result.stderr).toBe('[killed: session closed]')
  })
})

describe('createShellService', () => {
  it('rejects a second command while one is running on the same session, and frees the slot after', async () => {
    const shell = createShellService({ timeoutMs: 5000 })
    const first = shell.run('s1', tempDir(), 'sleep 0.3; echo one')
    await expect(shell.run('s1', tempDir(), 'echo two')).rejects.toThrow(/still running/)
    expect(shell.running('s1')).toBe(true)
    await expect(shell.run('s2', tempDir(), 'echo other')).resolves.toMatchObject({ stdout: 'other\n' })
    expect((await first).stdout).toBe('one\n')
    expect(shell.running('s1')).toBe(false)
    await expect(shell.run('s1', tempDir(), 'echo two')).resolves.toMatchObject({ stdout: 'two\n' })
  })

  it('kills a running command when its session closes or parks', async () => {
    const shell = createShellService({ timeoutMs: 10_000 })
    let listener: ((event: SessionEvent) => void) | undefined
    let seq = 0
    const runner = {
      ...fakeRunner('s1', { cwd: '/tmp' }),
      subscribe: (fn: (event: SessionEvent) => void) => {
        listener = fn
        return () => {}
      },
    }
    const emit = (body: SessionEventBody) => listener!({ ...body, seq: ++seq, ts: Date.now() } as SessionEvent)
    shell.watch(runner)

    const closed = shell.run('s1', tempDir(), 'sleep 30')
    emit({ type: 'session_closed', reason: 'client' })
    expect((await closed).stderr).toMatch(/killed: session closed/)

    const parked = shell.run('s1', tempDir(), 'sleep 30')
    emit({ type: 'status_changed', status: 'parked' })
    expect((await parked).stderr).toMatch(/killed: session parked/)

    const shutdown = shell.run('s1', tempDir(), 'sleep 30')
    shell.killAll()
    expect((await shutdown).stderr).toMatch(/killed: server shutting down/)
  })

  it('applies the configured defaults', () => {
    const shell = createShellService()
    expect(shell.timeoutMs).toBe(120_000)
    expect(shell.maxOutputBytes).toBe(32 * 1024)
  })
})

describe('shellPermitted', () => {
  const claude = {
    ...fakeRunner('c', { cwd: '/tmp' }),
    info: () => ({ ...fakeRunner('c', { cwd: '/tmp' }).info(), engine: 'claude' as const }),
  }
  const provider = { ...fakeRunner('p', {}), info: () => ({ ...fakeRunner('p', {}).info(), engine: 'provider' as const }) }
  const shell = createShellService()

  it('needs the service, the operator and a host cwd, all three', () => {
    expect(shellPermitted(shell, claude, true)).toBe(true)
    expect(shellPermitted(null, claude, true)).toBe(false)
    expect(shellPermitted(shell, claude, false)).toBe(false)
    expect(shellPermitted(shell, provider, true)).toBe(false)
    expect(shellPermitted(shell, fakeRunner('anon', { cwd: '/tmp' }), true)).toBe(false)
  })
})

describe('shellChildEnv', () => {
  it('copies only defined entries', () => {
    expect(shellChildEnv({ A: '1', B: undefined })).toEqual({ A: '1' })
  })
})
