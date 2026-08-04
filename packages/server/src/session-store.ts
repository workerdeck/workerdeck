import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ParkedExecution, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'

/**
 * A session with its live runner torn down, waiting on deferred executions.
 *
 * Everything needed to bring it back: the wire-visible info (so it still lists and
 * reads over REST while parked), the config to rebuild the runner, the engine's
 * snapshot, and what it is waiting for.
 */
export type ParkedSessionRecord = {
  id: string
  /** Session info as of the park, with `status: 'parked'`. */
  info: SessionInfo
  profile?: string
  /** The config the session was created with (profile defaults already applied). */
  config: SessionRunnerConfig
  snapshot: RunnerSnapshot
  executions: ParkedExecution[]
  parkedAt: number
}

/**
 * Where parked sessions live. Two implementations ship: {@link MemorySessionStore}
 * (a park survives a disconnect, not a restart) and {@link createFileSessionStore}
 * (it survives both, on one host); a redis/sqlite/table store implements the same
 * four operations.
 *
 * Two things to know before writing one: the record holds the session's whole
 * transcript and tool I/O, and `config` may carry host-injected values (env, hooks,
 * injected functions) that a JSON round-trip silently drops or, worse, persists.
 * {@link toDurableRecord} is the filter the bundled file store applies — reuse it.
 */
export interface SessionStore {
  save(record: ParkedSessionRecord): Promise<void>
  get(id: string): Promise<ParkedSessionRecord | null>
  list(): Promise<ParkedSessionRecord[]>
  delete(id: string): Promise<boolean>
}

/** Single-process, no persistence: parks survive a client disconnect, not a restart. */
export class MemorySessionStore implements SessionStore {
  #records = new Map<string, ParkedSessionRecord>()

  save(record: ParkedSessionRecord): Promise<void> {
    this.#records.set(record.id, record)
    return Promise.resolve()
  }

  get(id: string): Promise<ParkedSessionRecord | null> {
    return Promise.resolve(this.#records.get(id) ?? null)
  }

  list(): Promise<ParkedSessionRecord[]> {
    return Promise.resolve([...this.#records.values()])
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#records.delete(id))
  }
}

/**
 * Config fields that must not be written to durable storage: two are functions
 * (JSON drops them silently), `extraOptions` is SDK `Options` and may hold hooks
 * and callbacks, and `env` is a credential-bearing map — the same rule
 * `profile-store.ts` follows, for the same reason.
 *
 * Dropping them costs a rehydrated session nothing: all four are consumed by the
 * Claude engine alone, and the Claude engine cannot park (the CLI owns its process
 * state — `buildRunner` refuses a `restore` for it). A provider session's
 * credentials are resolved by `createEngineRunner` from the operator's environment
 * on every build, wake included.
 */
const EPHEMERAL_CONFIG_KEYS = ['queryFn', 'historyFn', 'extraOptions', 'env'] as const

/** The record as it may be persisted: same session, config narrowed to what is
 * safe and meaningful to keep (see {@link EPHEMERAL_CONFIG_KEYS}). */
export function toDurableRecord(record: ParkedSessionRecord): ParkedSessionRecord {
  const config: SessionRunnerConfig = { ...record.config }
  for (const key of EPHEMERAL_CONFIG_KEYS) delete config[key]
  return { ...record, config }
}

/** Bump when the on-disk shape changes incompatibly; records written by another
 * version are ignored rather than half-read into a broken session. */
const FORMAT_VERSION = 1

export type FileSessionStoreOptions = {
  /** Directory holding one JSON file per parked session.
   * Default `<cwd>/.workerdeck/parked`. */
  dir?: string
  /** A record that could not be read or written. Losing one is losing a session's
   * way back, so this is worth logging — the store itself stays quiet and skips it. */
  onError?: (error: unknown, context: { path: string; op: 'save' | 'read' | 'delete' }) => void
}

/**
 * Durable single-host store: one JSON file per parked session under `dir`, written
 * through a temp file and a rename so a crash mid-write cannot truncate a session.
 * `hydrate()` at `listen()` picks them up, re-indexes their executions, and re-arms
 * the watchdogs, so a restart no longer loses parked work.
 *
 * Know what is on that disk: **the record holds the session's entire transcript** —
 * prompts, model output, and tool I/O — in plaintext. Put it somewhere with the same
 * protection as the SDK's own transcripts (`~/.claude/projects`), not in a directory
 * that gets served, synced, or backed up somewhere looser.
 *
 * Single-process by design, exactly like the bundled queue adapter and profile
 * store: two servers sharing one directory would both hydrate the same records and
 * race to rebuild them. That is what the seam is for.
 *
 * Nothing here reaps: a record leaves only when its session wakes or is deleted.
 * An execution dispatched without a deadline (a `DeferredExecutor` with no
 * `timeoutMs`) has no watchdog to end the wait, so its record — and its transcript
 * — stays until `DELETE /sessions/:id`. Give deferred calls a deadline, or sweep.
 */
export function createFileSessionStore(options: FileSessionStoreOptions = {}): SessionStore {
  const dir = options.dir ?? join(process.cwd(), '.workerdeck', 'parked')
  // Encoded, not interpolated: an id is a runner-assigned string, and a '/' in one
  // would otherwise write outside `dir`.
  const fileFor = (id: string): string => join(dir, `${encodeURIComponent(id)}.json`)

  const read = async (path: string): Promise<ParkedSessionRecord | null> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      // Absent is the ordinary case: nothing parked under that id. Anything else
      // (EACCES, EIO) is a session we cannot reach, and reporting it as "nothing
      // is parked" is how a restart guard ends up saying the coast is clear.
      if (isMissing(error)) return null
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
        )
      }
      try {
        // Transcripts, so owner-only: the docs say protect this like
        // `~/.claude/projects`, and the default 0755/0644 wouldn't.
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
        if (isMissing(error)) return [] // No directory yet: nothing has parked here.
        // An unreadable directory is not an empty one. `hydrate()` runs inside
        // `listen()`, so throwing here refuses the boot instead of coming up as a
        // server that has quietly forgotten every parked session.
        options.onError?.(error, { path: dir, op: 'read' })
        throw error
      }
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const record = await read(join(dir, name))
            if (!record) return null
            // A record only answers `get`/`delete` under the name its id encodes to.
            // One that got here some other way (a copy, an ops rename) would list
            // forever and be unreachable — better to say so than to serve a ghost.
            if (`${encodeURIComponent(record.id)}.json` === name) return record
            options.onError?.(
              new Error(`parked record '${record.id}' is stored as '${name}' and cannot be read back by id`),
              { path: join(dir, name), op: 'read' },
            )
            return null
          }),
      )
      return records.filter((record): record is ParkedSessionRecord => record !== null)
    },

    delete: async (id) => {
      const path = fileFor(id)
      try {
        await rm(path)
        return true
      } catch (error) {
        // Missing is not an error — a discard racing a wake-up hits this.
        if (isMissing(error)) return false
        options.onError?.(error, { path, op: 'delete' })
        return false
      }
    },
  }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Shape-check a parsed file. A record missing any of these could not be rebuilt,
 * and half-restoring one is worse than skipping it. */
function parseRecord(value: unknown): ParkedSessionRecord | null {
  if (!value || typeof value !== 'object') return null
  const envelope = value as { version?: unknown; record?: unknown }
  if (envelope.version !== FORMAT_VERSION) return null
  const record = envelope.record as Partial<ParkedSessionRecord> | null
  if (!record || typeof record !== 'object') return null
  if (typeof record.id !== 'string' || typeof record.parkedAt !== 'number') return null
  if (!record.info || !record.config || !record.snapshot) return null
  if (!Array.isArray(record.executions)) return null
  return record as ParkedSessionRecord
}
