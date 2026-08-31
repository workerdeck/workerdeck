import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ParkedExecution, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'

export type ParkedSessionRecord = {
  kind?: 'parked' | 'live'
  id: string
  info: SessionInfo
  profile?: string
  config: SessionRunnerConfig
  snapshot: RunnerSnapshot
  executions: ParkedExecution[]
  parkedAt: number
}

export function isLiveRecord(record: StoredSessionRecord): boolean {
  return record.kind === 'live'
}

export type DormantSessionRecord = {
  kind: 'dormant'
  id: string
  info: SessionInfo
  profile?: string
  config: SessionRunnerConfig
  sdkSessionId: string
  savedAt: number
}

export type StoredSessionRecord = ParkedSessionRecord | DormantSessionRecord

export function isDormant(record: StoredSessionRecord): record is DormantSessionRecord {
  return record.kind === 'dormant'
}

export interface SessionStore {
  save(record: StoredSessionRecord): Promise<void>
  get(id: string): Promise<StoredSessionRecord | null>
  list(): Promise<StoredSessionRecord[]>
  delete(id: string): Promise<boolean>
}

export class MemorySessionStore implements SessionStore {
  #records = new Map<string, StoredSessionRecord>()

  save(record: StoredSessionRecord): Promise<void> {
    this.#records.set(record.id, record)
    return Promise.resolve()
  }

  get(id: string): Promise<StoredSessionRecord | null> {
    return Promise.resolve(this.#records.get(id) ?? null)
  }

  list(): Promise<StoredSessionRecord[]> {
    return Promise.resolve([...this.#records.values()])
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#records.delete(id))
  }
}

const EPHEMERAL_CONFIG_KEYS = ['queryFn', 'historyFn', 'extraOptions', 'env'] as const

export function toDurableRecord<T extends StoredSessionRecord>(record: T): T {
  const config: SessionRunnerConfig = { ...record.config }
  for (const key of EPHEMERAL_CONFIG_KEYS) {
    delete config[key]
  }
  return { ...record, config }
}

const FORMAT_VERSION = 1

export type FileSessionStoreOptions = {
  dir?: string
  onError?: (error: unknown, context: { path: string; op: 'save' | 'read' | 'delete' }) => void
}

export function createFileSessionStore(options: FileSessionStoreOptions = {}): SessionStore {
  const dir = options.dir ?? join(process.cwd(), '.workerdeck', 'parked')
  // Encoded, not interpolated: an id is a runner-assigned string, and a '/' in one would otherwise write outside `dir`.
  const fileFor = (id: string): string => join(dir, `${encodeURIComponent(id)}.json`)

  const read = async (path: string): Promise<StoredSessionRecord | null> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      // Only absence is "nothing parked": reporting an EACCES as one is how a restart guard ends up saying the coast is clear.
      if (isMissing(error)) {
        return null
      }
      options.onError?.(error, { path, op: 'read' })
      return null
    }
    try {
      return parseRecord(JSON.parse(raw))
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
        payload = JSON.stringify({ version: FORMAT_VERSION, record: toDurableRecord(record) })
      } catch (error) {
        options.onError?.(error, { path, op: 'save' })
        throw new Error(
          `parked session '${record.id}' is not JSON-serializable — a host-injected value ` +
            `reached its config or snapshot: ${String(error)}`,
          { cause: error },
        )
      }
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, payload, { mode: 0o600 })
        await rename(temp, path)
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
            options.onError?.(new Error(`parked record '${record.id}' is stored as '${name}' and cannot be read back by id`), {
              path: join(dir, name),
              op: 'read',
            })
            return null
          }),
      )
      return records.filter((record): record is StoredSessionRecord => record !== null)
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function parseRecord(value: unknown): StoredSessionRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const envelope = value as { version?: unknown; record?: unknown }
  if (envelope.version !== FORMAT_VERSION) {
    return null
  }
  const record = envelope.record as Partial<StoredSessionRecord> | null
  if (!record || typeof record !== 'object') {
    return null
  }
  if (typeof record.id !== 'string') {
    return null
  }
  if (!record.info || !record.config) {
    return null
  }
  if (record.kind === 'dormant') {
    const dormant = record as Partial<DormantSessionRecord>
    if (typeof dormant.sdkSessionId !== 'string' || typeof dormant.savedAt !== 'number') {
      return null
    }
    return dormant as DormantSessionRecord
  }
  const parked = record as Partial<ParkedSessionRecord>
  if (typeof parked.parkedAt !== 'number' || !parked.snapshot) {
    return null
  }
  if (!Array.isArray(parked.executions)) {
    return null
  }
  return parked as ParkedSessionRecord
}
