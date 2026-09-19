import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runReload } from '../src/dev/reload-command.ts'

describe('workerdeck reload', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wd-reload-'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reports no instance when the state dir holds no pidfile', async () => {
    expect(await runReload(['--state-dir', dir])).toBe(1)
  })

  it('reports no instance when the pidfile is not a pid', async () => {
    writeFileSync(join(dir, 'gateway.pid'), 'not-a-pid\n')
    expect(await runReload(['--state-dir', dir])).toBe(1)
  })

  it('reports no instance when the pid is gone', async () => {
    // A pid that cannot be alive: the kernel refuses to allocate it.
    writeFileSync(join(dir, 'gateway.pid'), '2147483646\n')
    expect(await runReload(['--state-dir', dir])).toBe(1)
  })

  it('sends SIGUSR2 to the pid named by the pidfile', async () => {
    writeFileSync(join(dir, 'gateway.pid'), `${process.pid}\n`)
    const signalled = new Promise<void>((resolve) => process.once('SIGUSR2', () => resolve()))
    expect(await runReload(['--state-dir', dir])).toBe(0)
    await signalled
  })

  it('refuses arguments it does not know', async () => {
    expect(await runReload(['--group'])).toBe(2)
  })
})
