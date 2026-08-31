import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { materializeAuthKey } from '../src/auth/auth-key.ts'

const created: string[] = []
async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-key-'))
  created.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

const HEX_48 = /^[0-9a-f]{48}$/

describe('materializeAuthKey', () => {
  it('creates a key file under the state dir, mode 0600', async () => {
    const dir = await tempStateDir()
    const result = await materializeAuthKey(dir)
    expect(result.source).toBe('created')
    expect(result.key).toMatch(HEX_48)
    expect(result.path).toBe(join(dir, 'auth-key'))
    expect((await readFile(result.path!, 'utf8')).trim()).toBe(result.key)
    expect(((await stat(result.path!)).mode & 0o777).toString(8)).toBe('600')
  })

  it('creates the state dir itself when missing', async () => {
    const dir = join(await tempStateDir(), 'nested', '.workerdeck')
    const result = await materializeAuthKey(dir)
    expect(result.source).toBe('created')
    expect((await readFile(join(dir, 'auth-key'), 'utf8')).trim()).toBe(result.key)
  })

  it('reuses the stored key on a later launch — a restart must not un-pair clients', async () => {
    const dir = await tempStateDir()
    const first = await materializeAuthKey(dir)
    const second = await materializeAuthKey(dir)
    expect(second.source).toBe('stored')
    expect(second.key).toBe(first.key)
  })

  it('is ephemeral without a state dir, minting a fresh key per run', async () => {
    const a = await materializeAuthKey(null)
    const b = await materializeAuthKey(null)
    expect(a.source).toBe('ephemeral')
    expect(a.path).toBeNull()
    expect(a.key).toMatch(HEX_48)
    expect(a.key).not.toBe(b.key)
  })

  it('regenerates over an empty or too-short file rather than crashing', async () => {
    const dir = await tempStateDir()
    const path = join(dir, 'auth-key')
    await writeFile(path, '')
    expect((await materializeAuthKey(dir)).source).toBe('created')

    await writeFile(path, 'short\n')
    const result = await materializeAuthKey(dir)
    expect(result.source).toBe('created')
    expect(result.key).toMatch(HEX_48)
  })

  it('regenerates over non-printable garbage — both transports need one clean line', async () => {
    const dir = await tempStateDir()
    await writeFile(join(dir, 'auth-key'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))
    expect((await materializeAuthKey(dir)).source).toBe('created')
  })

  it('restores 0600 when regenerating over a corrupt file with loose bits', async () => {
    const dir = await tempStateDir()
    const path = join(dir, 'auth-key')
    await writeFile(path, 'bad\n', { mode: 0o644 })
    await materializeAuthKey(dir)
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
  })

  it('warns — but still serves — when the stored key is readable by others', async () => {
    const dir = await tempStateDir()
    const first = await materializeAuthKey(dir)
    await chmod(first.path!, 0o644)
    const warn = vi.fn()
    const result = await materializeAuthKey(dir, { warn })
    expect(result.source).toBe('stored')
    expect(result.key).toBe(first.key)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chmod 600'))
  })

  it('trims whitespace so a hand-edited file with a trailing newline still matches', async () => {
    const dir = await tempStateDir()
    await writeFile(join(dir, 'auth-key'), '  operator-chosen-key-material  \n', { mode: 0o600 })
    const result = await materializeAuthKey(dir)
    expect(result.source).toBe('stored')
    expect(result.key).toBe('operator-chosen-key-material')
  })
})
