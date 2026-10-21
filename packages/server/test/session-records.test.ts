import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRunnerConfig } from '@workerdeck/core'
import {
  createFileSessionRecordStore,
  MemorySessionRecordStore,
  SessionRecords,
  StaleConversationError,
  type SessionRecord,
} from '../src/index.ts'
import type { DormantSessionRecord } from '../src/services/session-store.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wd-records-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function dormant(id: string, config: Partial<SessionRunnerConfig> = {}): DormantSessionRecord {
  return {
    kind: 'dormant',
    id,
    info: { id, status: 'idle', cwd: '/tmp/project', createdAt: 1, lastSeq: 0, pendingPermissionCount: 0 },
    config: { cwd: '/tmp/project', ...config },
    sdkSessionId: 'sdk-1',
    savedAt: 2,
  }
}

function ledger(id: string, conversation = 1): SessionRecord {
  return { id, owner: 'tobias', conversation, conversations: [{ n: 1, endedAt: 5 }], createdAt: 1 }
}

describe('SessionRecords', () => {
  it('keeps the ledger fields across a runtime save and clear', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('s1', () => ledger('s1'))

    await records.saveRuntime(dormant('s1', { model: 'opus' }))
    const saved = await records.get('s1')
    expect(saved).toMatchObject({ owner: 'tobias', conversation: 1, conversations: [{ n: 1, endedAt: 5 }], createdAt: 1 })
    expect(saved?.runtime?.kind).toBe('dormant')
    expect(saved?.running).toEqual({ cwd: '/tmp/project', model: 'opus' })

    expect(await records.clearRuntime('s1')).toBe(true)
    const cleared = await records.get('s1')
    expect(cleared?.runtime).toBeUndefined()
    expect(cleared).toMatchObject({ owner: 'tobias', conversations: [{ n: 1, endedAt: 5 }] })
    expect(await records.clearRuntime('s1')).toBe(false)
  })

  it('refuses a runtime save or clear taken for another conversation', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('s1', () => ledger('s1', 2))
    await records.saveRuntime(dormant('s1'), 2)

    await expect(records.saveRuntime({ ...dormant('s1'), sdkSessionId: 'stale' }, 1)).rejects.toBeInstanceOf(StaleConversationError)
    await expect(records.clearRuntime('s1', 1)).rejects.toBeInstanceOf(StaleConversationError)
    await expect(records.runtimeStore().delete('s1', 3)).rejects.toBeInstanceOf(StaleConversationError)
    expect((await records.get('s1'))?.runtime).toMatchObject({ sdkSessionId: 'sdk-1' })

    expect(await records.runtimeStore().delete('s1', 2)).toBe(true)
    expect((await records.get('s1'))?.runtime).toBeUndefined()
  })

  it('takes the write token from a runtime record that carries its conversation', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('s1', () => ledger('s1', 2))
    const stale = dormant('s1')
    stale.info = { ...stale.info, conversation: 1 } as DormantSessionRecord['info']
    await expect(records.runtimeStore().save(stale)).rejects.toBeInstanceOf(StaleConversationError)
    expect((await records.get('s1'))?.runtime).toBeUndefined()
  })

  it('runs one transaction per id at a time, each on the latest record', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('s1', () => ({ ...ledger('s1'), conversations: [] }))
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        records.transact('s1', (current) => ({ ...current!, conversations: [...current!.conversations, { n: i, endedAt: i }] })),
      ),
    )
    expect((await records.get('s1'))?.conversations.map((entry) => entry.n)).toEqual([0, 1, 2, 3, 4])
  })

  it('writes nothing for an undefined merge and removes the record for a null one', async () => {
    const store = new MemorySessionRecordStore()
    const save = vi.spyOn(store, 'save')
    const records = new SessionRecords(store)
    await records.transact('s1', () => ledger('s1'))
    expect(await records.transact('s1', () => undefined)).toMatchObject({ id: 's1' })
    expect(save).toHaveBeenCalledTimes(1)
    expect(await records.transact('s1', () => null)).toBeNull()
    expect(await store.get('s1')).toBeNull()
  })
})

describe('the runtime adapter', () => {
  it('removes the file only when the record holds nothing but its runtime', async () => {
    const records = new SessionRecords(createFileSessionRecordStore({ dir }))
    const runtime = records.runtimeStore()

    await runtime.save(dormant('bare'))
    expect(await readdir(dir)).toEqual(['bare.json'])
    expect(await runtime.delete('bare')).toBe(true)
    expect(await readdir(dir)).toEqual([])

    await records.transact('kept', () => ledger('kept'))
    await runtime.save(dormant('kept'))
    expect(await runtime.delete('kept')).toBe(true)
    expect(await readdir(dir)).toEqual(['kept.json'])
    expect(await runtime.get('kept')).toBeNull()
    expect(await runtime.list()).toEqual([])
    expect((await records.get('kept'))?.conversations).toHaveLength(1)
  })

  it('lists runtimes only, skipping records without one', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('ledger-only', () => ledger('ledger-only'))
    await records.runtimeStore().save(dormant('s1'))
    expect((await records.runtimeStore().list()).map((record) => record.id)).toEqual(['s1'])
  })
})

describe('createFileSessionRecordStore', () => {
  it('round-trips a record and strips host-only config from runtime, running and requested', async () => {
    const store = createFileSessionRecordStore({ dir })
    const secret = { env: { ANTHROPIC_API_KEY: 'sk-secret' }, model: 'opus' } as Partial<SessionRunnerConfig>
    const record: SessionRecord = {
      ...ledger('s1'),
      runtime: dormant('s1', secret),
      running: { cwd: '/tmp/project', ...secret },
      requested: { cwd: '/tmp/project', ...secret },
    }
    await store.save(record)

    expect(await readFile(join(dir, 's1.json'), 'utf8')).not.toContain('sk-secret')
    const read = await store.get('s1')
    expect(read?.runtime?.config).toEqual({ cwd: '/tmp/project', model: 'opus' })
    expect(read?.running).toEqual({ cwd: '/tmp/project', model: 'opus' })
    expect(read?.requested).toEqual({ cwd: '/tmp/project', model: 'opus' })
    expect(read).toMatchObject({ owner: 'tobias', conversation: 1, conversations: [{ n: 1, endedAt: 5 }] })
    expect((await store.list()).map((entry) => entry.id)).toEqual(['s1'])

    expect(await store.delete('s1')).toBe(true)
    expect(await store.get('s1')).toBeNull()
    expect(await store.delete('s1')).toBe(false)
  })

  it('skips bad files instead of failing the boot', async () => {
    const onError = vi.fn()
    const store = createFileSessionRecordStore({ dir, onError })
    await store.save(ledger('good'))
    const write = (name: string, record: unknown, version = 2) => writeFile(join(dir, name), JSON.stringify({ version, record }))
    await write('old.json', ledger('old'), 1)
    await write('no-conversation.json', { ...ledger('no-conversation'), conversation: 0 })
    await write('no-history.json', { ...ledger('no-history'), conversations: undefined })
    await write('foreign.json', { ...ledger('foreign'), runtime: dormant('someone-else') })
    await write('broken-runtime.json', { ...ledger('broken-runtime'), runtime: { id: 'broken-runtime' } })
    await writeFile(join(dir, 'truncated.json'), '{"version":2,"record":{"id":"tru')

    expect((await store.list()).map((record) => record.id)).toEqual(['good'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({ op: 'read' })
  })
})
