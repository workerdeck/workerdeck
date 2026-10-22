import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { PendingPromptInfo, ProfileEngine } from '@workerdeck/protocol'
import { isMissing, writeFileAtomic } from '../lib/atomic-file.ts'
import type { StoredAgent } from './agent-store.ts'
import {
  durableConfig,
  parseStoredRecord,
  toDurableRecord,
  type EngineHome,
  type RuntimeClear,
  type SessionStore,
  type StoredSessionRecord,
} from './session-store.ts'

export type FrozenAuth = { owner?: string; scope?: Record<string, string>; originalSessionId?: string }

export type ConversationEntry = {
  n: number
  engine: ProfileEngine
  profile?: string
  engineHome?: EngineHome
  cwd: string
  engineSessionId?: string
  snapshot?: RunnerSnapshot
  running?: SessionRunnerConfig
  title?: string
  costUsd?: number
  startedAt: number
  endedAt: number
  executions: string[]
  auth: FrozenAuth
  transcript?: 'unavailable'
}

export type SessionCut = { from: number; to: number; phase: 'prepared' | 'committed'; epoch: number; target: SessionRunnerConfig }

export type PendingPrompt = PendingPromptInfo

export type StartFailure = { n: number; error: string }

// A named create's identity, kept with its first-start intent: the first conversation never starts without its index row.
export type PendingIdentity = { agent: StoredAgent; crossOwner?: boolean; remoteLead?: string }

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
  identity?: PendingIdentity
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

const FORMAT_VERSION = 1

// Old state shares format number 1, so it is told apart by shape: a pre-4.0 file is the bare runtime record, with
// `kind` (or, before kinds, `parkedAt`) on top and no `conversation`.
export function isPreMergeRecord(value: unknown): boolean {
  const record = (value as { record?: unknown } | null)?.record as Record<string, unknown> | null | undefined
  if (!record || typeof record !== 'object' || record.conversation !== undefined) {
    return false
  }
  return typeof record.kind === 'string' || 'parkedAt' in record
}

export class UnsupportedStateError extends Error {
  constructor(
    readonly path: string,
    reason = 'was written by WorkerDeck before 4.0.0 and must be migrated before this gateway can start',
  ) {
    super(`${path} ${reason}`)
  }
}

export class StaleConversationError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`session ${sessionId} is on conversation ${actual}, not ${expected}`)
  }
}

export class MissingConversationError extends Error {
  constructor(readonly sessionId: string) {
    super(`a runtime write for session ${sessionId} names no conversation`)
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

// `firstStart`: the create's start intent (and its first message) land with the record, so no crash loses either.
export type SessionOpening = Pick<SessionRecord, 'owner' | 'scope' | 'requested'> & {
  firstStart?: { epoch: number; target: SessionRunnerConfig; prompt?: string; identity?: PendingIdentity }
}

export class SessionRecords {
  #store: SessionRecordStore
  #ops = new Map<string, Promise<void>>()
  #conversations = new Map<string, number>()

  constructor(store: SessionRecordStore) {
    this.#store = store
  }

  get(id: string): Promise<SessionRecord | null> {
    return this.#serial(id, async () => this.#known(id, await this.#store.get(id)))
  }

  async list(): Promise<SessionRecord[]> {
    const records = await this.#store.list()
    for (const record of records) {
      this.#observe(record.id, record.conversation)
    }
    return records
  }

  // The committed conversation, as far as this process has read or written it; undefined for an id it has not seen.
  conversationOf(id: string): number | undefined {
    return this.#conversations.get(id)
  }

  // A hot-reload carry: the conversation the previous generation knew, before this one has read the record.
  prime(id: string, conversation: number): void {
    this.#observe(id, conversation)
  }

  // `merge` is synchronous on purpose: a transaction must never await parking, a runner, or another queued op.
  // `undefined` leaves the record as it is, `null` removes it.
  transact(id: string, merge: SessionRecordMerge): Promise<SessionRecord | null> {
    return this.#serial(id, async () => {
      const current = this.#known(id, await this.#store.get(id))
      const next = merge(current)
      if (next === undefined) {
        return current
      }
      if (next === null) {
        if (current) {
          await this.#store.delete(id)
        }
        this.#conversations.delete(id)
        return null
      }
      await this.#store.save(next)
      this.#conversations.set(id, next.conversation)
      return next
    })
  }

  // A transaction whose result must be on disk before the caller acts on it: read back and compared.
  async transactDurable(id: string, merge: (current: SessionRecord | null) => SessionRecord): Promise<SessionRecord> {
    const next = (await this.transact(id, merge))!
    const back = await this.#serial(id, () => this.#store.get(id))
    if (!back || durableView(back) !== durableView(next)) {
      throw new Error(`session record '${id}' did not read back as written`)
    }
    return next
  }

  open(id: string, opening: SessionOpening): Promise<SessionRecord> {
    return this.transactDurable(id, (current) => {
      const { closedAt: _closed, ...base } = current ?? freshRecord(id)
      const next: SessionRecord = { ...base }
      for (const key of ['owner', 'scope', 'requested'] as const) {
        if (opening[key] === undefined) {
          delete next[key]
        } else {
          ;(next as Record<string, unknown>)[key] = opening[key]
        }
      }
      const first = opening.firstStart
      if (first && next.conversation === 1 && next.conversations.length === 0 && next.runtime === undefined) {
        next.cut = { from: 0, to: 1, phase: 'committed', epoch: first.epoch, target: first.target }
        if (first.prompt) {
          next.pendingPrompt = { text: first.prompt, n: 1, state: 'pending' }
        }
        if (first.identity) {
          next.identity = first.identity
        }
      }
      return next
    })
  }

  async saveRuntime(runtime: StoredSessionRecord, conversation: number | undefined): Promise<void> {
    await this.transact(runtime.id, (current) => {
      checkConversation(runtime.id, current, conversation)
      if (current?.closedAt !== undefined) {
        return undefined
      }
      const base = current ?? freshRecord(runtime.id)
      return { ...base, runtime, running: durableConfig(runtime.config) }
    })
  }

  // `resumed`: the runtime moved into a live runner and the session goes on. `ended`: the session is over, and a
  // record with nothing beyond its first conversation goes with it.
  async clearRuntime(id: string, conversation: number | undefined, reason: RuntimeClear = 'ended'): Promise<boolean> {
    let cleared = false
    await this.transact(id, (current) => {
      if (!current) {
        return undefined
      }
      checkConversation(id, current, conversation)
      cleared = current.runtime !== undefined
      if (reason === 'ended' && disposable(current)) {
        return null
      }
      if (!cleared) {
        return undefined
      }
      const next = { ...current }
      delete next.runtime
      return next
    })
    return cleared
  }

  // A record opened for a create that did not go through: removed only while it still holds nothing.
  async discard(id: string): Promise<void> {
    await this.transact(id, (current) =>
      current && current.runtime === undefined && disposable({ ...current, cut: current.cut?.from === 0 ? undefined : current.cut, pendingPrompt: undefined })
        ? null
        : undefined,
    )
  }

  // Seeding only (tests, the P2 migration): a runtime for a record still on its first conversation, no token asked.
  bootstrapRuntime(runtime: StoredSessionRecord): Promise<void> {
    return this.saveRuntime(runtime, conversationOf(runtime) ?? 1)
  }

  runtimeStore(): SessionStore {
    return {
      save: (record) => this.saveRuntime(record, conversationOf(record)),
      get: async (id) => (await this.get(id))?.runtime ?? null,
      list: async () => (await this.list()).flatMap((record) => (record.runtime ? [record.runtime] : [])),
      delete: (id, conversation, reason) => this.clearRuntime(id, conversation, reason),
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.#ops.values())
  }

  #known(id: string, record: SessionRecord | null): SessionRecord | null {
    if (record) {
      this.#conversations.set(id, record.conversation)
    }
    return record
  }

  // Unserialized reads (`list`, a carry) only ever raise n: one that started before a commit must not undo it.
  #observe(id: string, conversation: number): void {
    if ((this.#conversations.get(id) ?? 0) < conversation) {
      this.#conversations.set(id, conversation)
    }
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

// What the next conversation starts from: the session's durable config without anything bound to one conversation.
export function requestedConfig(config: SessionRunnerConfig): SessionRunnerConfig {
  const {
    prompt: _prompt,
    resume: _resume,
    forkSession: _fork,
    epoch: _epoch,
    engineHome: _home,
    statusLabel: _label,
    ...rest
  } = durableConfig(config)
  return rest
}

// An owner rename, not a transfer: the same person under a new name, so every copy follows, past conversations too.
export function withOwnerRenamed(record: SessionRecord, from: string, to: string): SessionRecord | undefined {
  let changed = false
  const owned = <T extends { owner?: string }>(value: T): T => {
    if (value.owner !== from) {
      return value
    }
    changed = true
    return { ...value, owner: to }
  }
  const next: SessionRecord = { ...owned(record) }
  for (const key of ['requested', 'running'] as const) {
    if (next[key]) {
      next[key] = owned(next[key])
    }
  }
  if (next.runtime) {
    next.runtime = { ...next.runtime, info: owned(next.runtime.info), config: owned(next.runtime.config) }
  }
  if (next.cut) {
    next.cut = { ...next.cut, target: owned(next.cut.target) }
  }
  if (next.identity) {
    next.identity = { ...next.identity, agent: owned(next.identity.agent) }
  }
  next.conversations = next.conversations.map((entry) => {
    const auth = owned(entry.auth)
    const running = entry.running && owned(entry.running)
    return auth === entry.auth && running === entry.running ? entry : { ...entry, auth, ...(running ? { running } : {}) }
  })
  return changed ? next : undefined
}

export function freshRecord(id: string): SessionRecord {
  return { id, conversation: 1, conversations: [], createdAt: Date.now() }
}

function checkConversation(id: string, current: SessionRecord | null, conversation: number | undefined): void {
  const actual = current?.conversation ?? 1
  if (conversation === undefined) {
    throw new MissingConversationError(id)
  }
  if (conversation !== actual) {
    throw new StaleConversationError(id, conversation, actual)
  }
}

// Owner, scope and config are the session's own: they go with it. Anything a cut or a close wrote keeps the record.
// The first conversation's start, still owed: the cut's committed intent from 0 to 1.
export function firstStartOwed(record: SessionRecord): boolean {
  return record.cut?.from === 0
}

export function disposable(record: SessionRecord): boolean {
  return (
    record.conversation === 1 &&
    record.conversations.length === 0 &&
    record.cut === undefined &&
    record.pendingPrompt === undefined &&
    record.startFailed === undefined &&
    record.closedAt === undefined
  )
}

function durableView(record: SessionRecord): string {
  const { conversation, cut, pendingPrompt, startFailed, closedAt, conversations, owner, scope } = toDurableSessionRecord(record)
  return JSON.stringify({
    conversation,
    cut,
    pendingPrompt,
    startFailed,
    closedAt,
    entries: conversations.map((entry) => entry.n),
    owner,
    scope,
  })
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
    ...(record.cut ? { cut: { ...record.cut, target: durableConfig(record.cut.target) } } : {}),
    conversations: record.conversations.map((entry) => (entry.running ? { ...entry, running: durableConfig(entry.running) } : entry)),
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
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      options.onError?.(error, { path, op: 'read' })
      return null
    }
    if (isPreMergeRecord(parsed)) {
      throw new UnsupportedStateError(path)
    }
    const version = (parsed as { version?: unknown } | null)?.version
    if (version !== FORMAT_VERSION) {
      throw new UnsupportedStateError(path, `has session format ${String(version)}, which this gateway cannot read`)
    }
    const record = parseSessionRecord(parsed)
    // A current record that does not parse would vanish with its cut.
    if (!record) {
      options.onError?.(new Error(`session record ${path} is incomplete and was skipped`), { path, op: 'read' })
    }
    return record
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
