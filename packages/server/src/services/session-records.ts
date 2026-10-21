import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionRunnerConfig } from '@workerdeck/core'
import { isMissing, writeFileAtomic } from '../lib/atomic-file.ts'
import {
  durableConfig,
  isArchived,
  parseStoredRecord,
  toDurableRecord,
  type SessionStore,
  type StoredSessionRecord,
} from './session-store.ts'

export type ConversationEntry = { n: number; endedAt: number }

export type SessionCut = { phase: 'pending' | 'committed' }

export type PendingPrompt = { text: string; n: number; state: 'pending' | 'sending' }

export type StartFailure = { n: number; error: string }

export type SessionRecord = {
  id: string
  owner?: string
  scope?: Record<string, string>
  conversation: number
  running?: SessionRunnerConfig
  requested?: SessionRunnerConfig
  runtime?: StoredSessionRecord
  conversations: ConversationEntry[]
  cut?: SessionCut
  pendingPrompt?: PendingPrompt
  startFailed?: StartFailure
  closedAt?: number
  createdAt: number
}

export interface SessionRecordStore {
  save(record: SessionRecord): Promise<void>
  get(id: string): Promise<SessionRecord | null>
  list(): Promise<SessionRecord[]>
  delete(id: string): Promise<boolean>
}

export type SessionRecordMerge = (current: SessionRecord | null) => SessionRecord | null | undefined

export type FileSessionRecordStoreOptions = {
  dir?: string
  onError?: (error: unknown, context: { path: string; op: 'save' | 'read' | 'delete' }) => void
}

const FORMAT_VERSION = 2

export class StaleConversationError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`session ${sessionId} is on conversation ${actual}, not ${expected}`)
  }
}

export class MemorySessionRecordStore implements SessionRecordStore {
  #records = new Map<string, SessionRecord>()

  save(record: SessionRecord): Promise<void> {
    this.#records.set(record.id, record)
    return Promise.resolve()
  }

  get(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.#records.get(id) ?? null)
  }

  list(): Promise<SessionRecord[]> {
    return Promise.resolve([...this.#records.values()])
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#records.delete(id))
  }
}

export class SessionRecords {
  #store: SessionRecordStore
  #ops = new Map<string, Promise<void>>()

  constructor(store: SessionRecordStore) {
    this.#store = store
  }

  get(id: string): Promise<SessionRecord | null> {
    return this.#serial(id, () => this.#store.get(id))
  }

  list(): Promise<SessionRecord[]> {
    return this.#store.list()
  }

  // `merge` is synchronous on purpose: a transaction must never await parking, a runner, or another queued op.
  // `undefined` leaves the record as it is, `null` removes it.
  transact(id: string, merge: SessionRecordMerge): Promise<SessionRecord | null> {
    return this.#serial(id, async () => {
      const current = await this.#store.get(id)
      const next = merge(current)
      if (next === undefined) {
        return current
      }
      if (next === null) {
        if (current) {
          await this.#store.delete(id)
        }
        return null
      }
      await this.#store.save(next)
      return next
    })
  }

  async saveRuntime(runtime: StoredSessionRecord, conversation?: number): Promise<void> {
    await this.transact(runtime.id, (current) => {
      checkConversation(runtime.id, current, conversation)
      const base = current ?? freshRecord(runtime.id)
      return isArchived(runtime) ? { ...base, runtime } : { ...base, runtime, running: durableConfig(runtime.config) }
    })
  }

  async clearRuntime(id: string, conversation?: number): Promise<boolean> {
    let cleared = false
    await this.transact(id, (current) => {
      if (!current?.runtime) {
        return undefined
      }
      checkConversation(id, current, conversation)
      cleared = true
      if (holdsOnlyRuntime(current)) {
        return null
      }
      const next = { ...current }
      delete next.runtime
      return next
    })
    return cleared
  }

  runtimeStore(): SessionStore {
    return {
      save: (record) => this.saveRuntime(record, conversationOf(record)),
      get: async (id) => (await this.get(id))?.runtime ?? null,
      list: async () => (await this.list()).flatMap((record) => (record.runtime ? [record.runtime] : [])),
      delete: (id, conversation) => this.clearRuntime(id, conversation),
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.#ops.values())
  }

  #serial<T>(id: string, op: () => Promise<T>): Promise<T> {
    const previous = this.#ops.get(id) ?? Promise.resolve()
    const result = previous.then(op)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.#ops.set(id, settled)
    void settled.then(() => {
      if (this.#ops.get(id) === settled) {
        this.#ops.delete(id)
      }
    })
    return result
  }
}

function freshRecord(id: string): SessionRecord {
  return { id, conversation: 1, conversations: [], createdAt: Date.now() }
}

function checkConversation(id: string, current: SessionRecord | null, conversation: number | undefined): void {
  const actual = current?.conversation ?? 1
  if (conversation !== undefined && conversation !== actual) {
    throw new StaleConversationError(id, conversation, actual)
  }
}

// `running` is left out: it only mirrors the runtime's config until a cut makes it the ledger's own.
function holdsOnlyRuntime(record: SessionRecord): boolean {
  return (
    record.conversation === 1 &&
    record.conversations.length === 0 &&
    record.owner === undefined &&
    record.scope === undefined &&
    record.requested === undefined &&
    record.cut === undefined &&
    record.pendingPrompt === undefined &&
    record.startFailed === undefined &&
    record.closedAt === undefined
  )
}

function conversationOf(record: StoredSessionRecord): number | undefined {
  const conversation = (record.info as { conversation?: unknown }).conversation
  return typeof conversation === 'number' ? conversation : undefined
}

export function toDurableSessionRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    ...(record.runtime ? { runtime: toDurableRecord(record.runtime) } : {}),
    ...(record.running ? { running: durableConfig(record.running) } : {}),
    ...(record.requested ? { requested: durableConfig(record.requested) } : {}),
  }
}

export function createFileSessionRecordStore(options: FileSessionRecordStoreOptions = {}): SessionRecordStore {
  const dir = options.dir ?? join(process.cwd(), '.workerdeck', 'sessions')
  // Encoded, not interpolated: an id is a runner-assigned string, and a '/' in one would otherwise write outside `dir`.
  const fileFor = (id: string): string => join(dir, `${encodeURIComponent(id)}.json`)

  const read = async (path: string): Promise<SessionRecord | null> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      // Only absence is "no record": reporting an EACCES as one is how a restart guard ends up saying the coast is clear.
      if (isMissing(error)) {
        return null
      }
      options.onError?.(error, { path, op: 'read' })
      return null
    }
    try {
      return parseSessionRecord(JSON.parse(raw))
    } catch (error) {
      options.onError?.(error, { path, op: 'read' })
      return null
    }
  }

  return {
    save: async (record) => {
      const path = fileFor(record.id)
      let payload: string
      try {
        payload = JSON.stringify({ version: FORMAT_VERSION, record: toDurableSessionRecord(record) })
      } catch (error) {
        options.onError?.(error, { path, op: 'save' })
        throw new Error(
          `session record '${record.id}' is not JSON-serializable - a host-injected value ` +
            `reached its config or snapshot: ${String(error)}`,
          { cause: error },
        )
      }
      try {
        await writeFileAtomic(path, payload)
      } catch (error) {
        options.onError?.(error, { path, op: 'save' })
        throw error
      }
    },

    get: (id) => read(fileFor(id)),

    list: async () => {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if (isMissing(error)) {
          return []
        }
        options.onError?.(error, { path: dir, op: 'read' })
        throw error
      }
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const record = await read(join(dir, name))
            if (!record) {
              return null
            }
            // A record only answers `get`/`delete` under the name its id encodes to; one that arrived some other way would be unreachable.
            if (`${encodeURIComponent(record.id)}.json` === name) {
              return record
            }
            options.onError?.(new Error(`session record '${record.id}' is stored as '${name}' and cannot be read back by id`), {
              path: join(dir, name),
              op: 'read',
            })
            return null
          }),
      )
      return records.filter((record): record is SessionRecord => record !== null)
    },

    delete: async (id) => {
      const path = fileFor(id)
      try {
        await rm(path)
        return true
      } catch (error) {
        if (isMissing(error)) {
          return false
        }
        options.onError?.(error, { path, op: 'delete' })
        return false
      }
    },
  }
}

function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const envelope = value as { version?: unknown; record?: unknown }
  if (envelope.version !== FORMAT_VERSION) {
    return null
  }
  const record = envelope.record as Partial<SessionRecord> | null
  if (!record || typeof record !== 'object' || typeof record.id !== 'string') {
    return null
  }
  if (!Number.isInteger(record.conversation) || (record.conversation as number) < 1) {
    return null
  }
  if (typeof record.createdAt !== 'number' || !Array.isArray(record.conversations)) {
    return null
  }
  if (record.runtime !== undefined) {
    const runtime = parseStoredRecord(record.runtime)
    if (!runtime || runtime.id !== record.id) {
      return null
    }
    record.runtime = runtime
  }
  return record as SessionRecord
}
