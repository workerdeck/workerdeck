import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRunnerConfig } from '@workerdeck/core'
import { createFileSessionStore, toDurableRecord, type ParkedSessionRecord } from '../src/index.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cw-parked-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function record(id: string, config: Partial<SessionRunnerConfig> = {}): ParkedSessionRecord {
  return {
    id,
    info: {
      id,
      status: 'parked',
      cwd: '/tmp/project',
      profile: 'kimi',
      engine: 'provider',
      createdAt: 1,
      lastSeq: 7,
      pendingPermissionCount: 0,
    },
    profile: 'kimi',
    config: { cwd: '/tmp/project', profile: 'kimi', ...config },
    snapshot: {
      engine: 'provider',
      id,
      createdAt: 1,
      seq: 7,
      events: [{ type: 'status_changed', status: 'parked', seq: 7, ts: 2 }],
      vfs: { '/out/report.md': '# draft' },
      parked: [{ executionId: 'exec-1', toolName: 'remote_task', expiresAt: 99 }],
      state: { messages: [{ role: 'assistant' }] },
    },
    executions: [{ executionId: 'exec-1', toolName: 'remote_task', expiresAt: 99 }],
    parkedAt: 3,
  }
}

describe('createFileSessionStore', () => {
  it('round-trips a record through the filesystem', async () => {
    const store = createFileSessionStore({ dir })
    await store.save(record('s1'))

    const read = await store.get('s1')
    expect(read).toEqual(record('s1'))
    expect(await store.list()).toEqual([record('s1')])
    expect((read as ParkedSessionRecord).snapshot.state).toEqual({ messages: [{ role: 'assistant' }] })

    expect(await store.delete('s1')).toBe(true)
    expect(await store.get('s1')).toBeNull()
    expect(await store.delete('s1')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('leaves no temp files behind and overwrites in place', async () => {
    const store = createFileSessionStore({ dir })
    await store.save(record('s1'))
    await store.save({ ...record('s1'), parkedAt: 44 })
    expect(await readdir(dir)).toEqual(['s1.json'])
    expect(((await store.get('s1')) as ParkedSessionRecord).parkedAt).toBe(44)
  })

  it('never writes credentials, functions, or SDK options to disk', async () => {
    const store = createFileSessionStore({ dir })
    await store.save(
      record('s1', {
        env: { ANTHROPIC_API_KEY: 'sk-secret' },
        queryFn: (() => {}) as unknown as SessionRunnerConfig['queryFn'],
        historyFn: (() => {}) as unknown as SessionRunnerConfig['historyFn'],
        extraOptions: { hooks: {} },
        model: 'kimi-k3',
      }),
    )

    const raw = await readFile(join(dir, 's1.json'), 'utf8')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain('ANTHROPIC_API_KEY')
    const stored = (await store.get('s1'))!.config
    expect(stored.env).toBeUndefined()
    expect(stored.extraOptions).toBeUndefined()
    expect(stored).toMatchObject({ cwd: '/tmp/project', profile: 'kimi', model: 'kimi-k3' })
  })

  it('keeps an id with a path separator inside its directory', async () => {
    const store = createFileSessionStore({ dir })
    await store.save(record('../escape/s1'))
    expect(await readdir(dir)).toEqual(['..%2Fescape%2Fs1.json'])
    expect((await store.get('../escape/s1'))?.id).toBe('../escape/s1')
  })

  it('skips a corrupt, truncated, or foreign-version file instead of failing the boot', async () => {
    const onError = vi.fn()
    const store = createFileSessionStore({ dir, onError })
    await store.save(record('good'))
    await writeFile(join(dir, 'truncated.json'), '{"version":1,"record":{"id":"tru')
    await writeFile(join(dir, 'shapeless.json'), '{"version":1,"record":{"id":"x"}}')
    await writeFile(join(dir, 'future.json'), '{"version":99,"record":{}}')
    await writeFile(join(dir, 'notes.txt'), 'ignored entirely')

    expect((await store.list()).map((r) => r.id)).toEqual(['good'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({ op: 'read' })
  })

  it('returns null for a session nothing parked', async () => {
    expect(await createFileSessionStore({ dir }).get('nobody')).toBeNull()
  })

  it('refuses to pass an unreadable directory off as an empty one', async () => {
    const onError = vi.fn()
    const store = createFileSessionStore({ dir, onError })
    await store.save(record('s1'))
    await chmod(dir, 0o000)
    try {
      await expect(store.list()).rejects.toThrow()
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      await chmod(dir, 0o700)
    }
  })

  it('reports a record stored under a name its id cannot address', async () => {
    const onError = vi.fn()
    const store = createFileSessionStore({ dir, onError })
    await store.save(record('s1'))
    await rename(join(dir, 's1.json'), join(dir, 'copy-of-s1.json'))

    expect(await store.list()).toEqual([])
    expect(onError.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining('s1') })
  })

  it('writes transcripts owner-only', async () => {
    await createFileSessionStore({ dir: join(dir, 'nested') }).save(record('s1'))
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'nested', 's1.json'))).mode & 0o777).toBe(0o600)
  })

  it('reports a record it cannot serialize rather than writing half of one', async () => {
    const onError = vi.fn()
    const store = createFileSessionStore({ dir, onError })
    const circular = record('s1')
    ;(circular.snapshot.state as Record<string, unknown>).self = circular.snapshot.state

    await expect(store.save(circular)).rejects.toThrow(/not JSON-serializable/)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('toDurableRecord', () => {
  it('narrows the config without touching the rest of the record', async () => {
    const source = record('s1', { env: { SECRET: 'x' }, model: 'kimi-k3' })
    const durable = toDurableRecord(source)
    expect(durable.config).toEqual({ cwd: '/tmp/project', profile: 'kimi', model: 'kimi-k3' })
    expect(durable.snapshot).toBe(source.snapshot)
    expect(source.config.env).toEqual({ SECRET: 'x' })
  })
})
