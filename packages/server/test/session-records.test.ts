import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRunnerConfig } from '@workerdeck/core'
import {
  createFileSessionRecordStore,
  MemorySessionRecordStore,
  SessionRecords,
  MissingConversationError,
  UnsupportedStateError,
  StaleConversationError,
  type SessionRecord,
  type SessionRecordStore,
} from '../src/index.ts'
import type { DormantSessionRecord } from '../src/services/session-store.ts'
import type { ConversationEntry } from '../src/services/session-records.ts'

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

function historyEntry(n: number, endedAt: number): ConversationEntry {
  return { n, engine: 'claude', cwd: '/tmp/project', startedAt: 0, endedAt, executions: [], auth: {} }
}

function ledger(id: string, conversation = 1): SessionRecord {
  return { id, owner: 'tobias', conversation, conversations: [historyEntry(1, 5)], createdAt: 1 }
}

describe('SessionRecords', () => {
  it('keeps the ledger fields across a runtime save and clear', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('s1', () => ledger('s1'))

    await records.saveRuntime(dormant('s1', { model: 'opus' }), 1)
    const saved = await records.get('s1')
    expect(saved).toMatchObject({ owner: 'tobias', conversation: 1, conversations: [{ n: 1, endedAt: 5 }], createdAt: 1 })
    expect(saved?.runtime?.kind).toBe('dormant')
    expect(saved?.running).toEqual({ cwd: '/tmp/project', model: 'opus' })

    expect(await records.clearRuntime('s1', 1, 'resumed')).toBe(true)
    const cleared = await records.get('s1')
    expect(cleared?.runtime).toBeUndefined()
    expect(cleared).toMatchObject({ owner: 'tobias', conversations: [{ n: 1, endedAt: 5 }] })
    expect(await records.clearRuntime('s1', 1, 'resumed')).toBe(false)
  })

  it('hands the record lifetime counts to every runtime it reads, never storing them in the runtime itself', async () => {
    const store = createFileSessionRecordStore({ dir })
    const records = new SessionRecords(store)
    await records.transact('s1', () => ({ ...ledger('s1', 2), counters: { activity: 40, prose: 9 } }))
    await records.saveRuntime(dormant('s1', { counterBase: { activity: 1, prose: 1 } }), 2)

    const raw = await store.get('s1')
    expect(raw?.runtime?.config.counterBase).toBeUndefined()
    expect(raw?.running?.counterBase).toBeUndefined()
    const runtimes = records.runtimeStore()
    expect((await runtimes.get('s1'))?.config.counterBase).toEqual({ activity: 40, prose: 9 })
    expect((await runtimes.list())[0]?.config.counterBase).toEqual({ activity: 40, prose: 9 })

    expect(await runtimes.delete('s1', 2, 'resumed')).toBe(true)
    expect((await records.get('s1'))?.counters).toEqual({ activity: 40, prose: 9 })
  })

  it('refuses a runtime save or clear taken for another conversation', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('s1', () => ledger('s1', 2))
    await records.saveRuntime(dormant('s1'), 2)

    await expect(records.saveRuntime({ ...dormant('s1'), sdkSessionId: 'stale' }, 1)).rejects.toBeInstanceOf(StaleConversationError)
    await expect(records.clearRuntime('s1', 1)).rejects.toBeInstanceOf(StaleConversationError)
    await expect(records.runtimeStore().delete('s1', 3)).rejects.toBeInstanceOf(StaleConversationError)
    await expect(records.runtimeStore().save(dormant('s1'))).rejects.toBeInstanceOf(MissingConversationError)
    await expect(records.runtimeStore().delete('s1', undefined)).rejects.toBeInstanceOf(MissingConversationError)
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
        records.transact('s1', (current) => ({ ...current!, conversations: [...current!.conversations, historyEntry(i, i)] })),
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

describe('the conversation cache', () => {
  it('never lets a slow list that read n undo a commit of n+1 that landed meanwhile', async () => {
    const inner = new MemorySessionRecordStore()
    let release: (() => void) | undefined
    const store: SessionRecordStore = {
      ...inner,
      save: (record) => inner.save(record),
      get: (id) => inner.get(id),
      delete: (id) => inner.delete(id),
      list: async () => {
        const seen = (await inner.list()).map((record) => ({ ...record }))
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return seen
      },
    }
    const records = new SessionRecords(store)
    await records.transact('s1', () => ledger('s1'))
    const listing = records.list()
    await vi.waitFor(() => expect(release).toBeDefined())
    await records.transact('s1', (current) => ({ ...current!, conversation: 2 }))
    release!()
    await listing
    expect(records.conversationOf('s1')).toBe(2)
  })
})

describe('the runtime adapter', () => {
  it('removes the file only when the record holds nothing but its runtime', async () => {
    const records = new SessionRecords(createFileSessionRecordStore({ dir }))
    const runtime = records.runtimeStore()

    await records.bootstrapRuntime(dormant('bare'))
    expect(await readdir(dir)).toEqual(['bare.json'])
    expect(await runtime.delete('bare', 1)).toBe(true)
    expect(await readdir(dir)).toEqual([])

    await records.transact('kept', () => ledger('kept'))
    await records.bootstrapRuntime(dormant('kept'))
    expect(await runtime.delete('kept', 1)).toBe(true)
    expect(await readdir(dir)).toEqual(['kept.json'])
    expect(await runtime.get('kept')).toBeNull()
    expect(await runtime.list()).toEqual([])
    expect((await records.get('kept'))?.conversations).toHaveLength(1)
  })

  it('lists runtimes only, skipping records without one', async () => {
    const records = new SessionRecords(new MemorySessionRecordStore())
    await records.transact('ledger-only', () => ledger('ledger-only'))
    await records.bootstrapRuntime(dormant('s1'))
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
    const write = (name: string, record: unknown, version = 1) => writeFile(join(dir, name), JSON.stringify({ version, record }))
    await write('no-conversation.json', { ...ledger('no-conversation'), conversation: 0 })
    await write('no-history.json', { ...ledger('no-history'), conversations: undefined })
    await write('foreign.json', { ...ledger('foreign'), runtime: dormant('someone-else') })
    await write('broken-runtime.json', { ...ledger('broken-runtime'), runtime: { id: 'broken-runtime' } })
    await writeFile(join(dir, 'truncated.json'), '{"version":1,"record":{"id":"tru')

    expect((await store.list()).map((record) => record.id)).toEqual(['good'])
    expect(onError).toHaveBeenCalledTimes(5)
    expect(onError.mock.calls.map((call) => call[1].op)).toEqual(['read', 'read', 'read', 'read', 'read'])
    expect(onError.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('incomplete'))).toHaveLength(4)
  })

  it('refuses a file written before 4.0.0 instead of skipping it', async () => {
    const store = createFileSessionRecordStore({ dir })
    await store.save(ledger('good'))
    const old = { kind: 'dormant', id: 'old', info: {}, config: {}, profile: 'claude-a', savedAt: 1 }
    await writeFile(join(dir, 'old.json'), JSON.stringify({ version: 1, record: old }))

    await expect(store.list()).rejects.toBeInstanceOf(UnsupportedStateError)
    await expect(store.get('old')).rejects.toThrow(/before 4\.0\.0/)
    expect((await store.get('good'))?.id).toBe('good')
  })

  it('refuses a record in a format version it cannot read', async () => {
    const store = createFileSessionRecordStore({ dir })
    await writeFile(join(dir, 'other.json'), JSON.stringify({ version: 2, record: ledger('other') }))
    await expect(store.list()).rejects.toThrow(/session format 2/)
  })

  it('refuses a parked record from before kinds existed', async () => {
    const store = createFileSessionRecordStore({ dir })
    await writeFile(join(dir, 'old.json'), JSON.stringify({ version: 1, record: { id: 'old', parkedAt: 1, executions: [] } }))
    await expect(store.list()).rejects.toBeInstanceOf(UnsupportedStateError)
  })
})
