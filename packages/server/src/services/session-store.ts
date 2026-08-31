import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ParkedExecution, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'

/**
 * A session captured whole: wire-visible info, the config to rebuild the runner, the engine's
 * snapshot, and what it is waiting for. `kind` discriminates the two: a **`parked`** record *is*
 * the session, so waking consumes it; a **`live`** one (`persistLive`) is a way back the session
 * still needs next time the process dies, so waking **refreshes it in place**. See
 * `docs/GOTCHAS.md` §Parking & bridged execution.
 */
export type ParkedSessionRecord = {
  /** Absent on records written before dormant sessions existed — those are all parked. */
  kind?: 'parked' | 'live'
  id: string
  /** Session info as of the write: `parked` for a park, `idle` for a live copy —
   * never `running`, which would come back as a spinner over no process. */
  info: SessionInfo
  profile?: string
  /** The config the session was created with (profile defaults already applied). */
  config: SessionRunnerConfig
  snapshot: RunnerSnapshot
  /** Empty for a live record: an idle session is waiting on nothing, so there is
   * nothing for `hydrate` to arm a watchdog for. */
  executions: ParkedExecution[]
  /** When it was written. Named for the park that came first. */
  parkedAt: number
}

/** A live record is refreshed in place on wake; a park is consumed by it. */
export const isLiveRecord = (record: StoredSessionRecord): boolean => record.kind === 'live'

/**
 * A live claude or codex session, remembered so it can be brought back after a gateway restart —
 * the counterpart to a park, and deliberately not the same mechanism. **It holds no transcript at
 * all**: just the id, the engine session id to resume from, and the config to rebuild with, so
 * rehydration is an ordinary create with `resume` set, done lazily on first attach. Written only
 * once an `sdkSessionId` exists. See `docs/GOTCHAS.md` §Parking & bridged execution.
 */
export type DormantSessionRecord = {
  kind: 'dormant'
  id: string
  /** Session info as of the last save, with `status: 'idle'` — whatever it was
   * doing, it is not doing it now. */
  info: SessionInfo
  profile?: string
  /**
   * The config the session was built from, minus the ephemeral keys. Fed back
   * through the server's `buildRunnerConfig` on wake rather than used as-is, so
   * the profile's env pin and the host hook's injections are **re-derived**
   * instead of persisted (see {@link EPHEMERAL_CONFIG_KEYS}).
   */
  config: SessionRunnerConfig
  /** Where the transcript actually lives. Without one there is nothing to resume. */
  sdkSessionId: string
  savedAt: number
}

/** What a {@link SessionStore} holds: a session waiting on deferred work, or one
 * waiting to be asked for again. */
export type StoredSessionRecord = ParkedSessionRecord | DormantSessionRecord

export const isDormant = (record: StoredSessionRecord): record is DormantSessionRecord => record.kind === 'dormant'

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
  save(record: StoredSessionRecord): Promise<void>
  get(id: string): Promise<StoredSessionRecord | null>
  list(): Promise<StoredSessionRecord[]>
  delete(id: string): Promise<boolean>
}

/** Single-process, no persistence: parks survive a client disconnect, not a restart. */
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

/**
 * Config fields that must never be written to durable storage: two are functions JSON eats
 * silently, `extraOptions` may hold hooks, and **`env` is a credential-bearing map**. Nothing is
 * lost, because a wake re-derives them — a provider session resolves credentials through
 * `createEngineRunner` on every build, and a dormant one is fed back through `buildRunnerConfig`.
 * See `docs/GOTCHAS.md` §Parking & bridged execution.
 */
const EPHEMERAL_CONFIG_KEYS = ['queryFn', 'historyFn', 'extraOptions', 'env'] as const

/** The record as it may be persisted: same session, config narrowed to what is
 * safe and meaningful to keep (see {@link EPHEMERAL_CONFIG_KEYS}). */
export const toDurableRecord = <T extends StoredSessionRecord>(record: T): T => {
  const config: SessionRunnerConfig = { ...record.config }
  for (const key of EPHEMERAL_CONFIG_KEYS) {
    delete config[key]
  }
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
 * Durable single-host store: one JSON file per parked session under `dir`, written temp-then-
 * rename so a crash mid-write cannot truncate a session. Single-process by design, like the
 * bundled queue adapter and profile store — that is what the seam is for.
 *
 * Know what is on that disk: **the record holds the session's entire transcript in plaintext**.
 * Protect `dir` like `~/.claude/projects`, and give deferred calls a deadline — nothing here
 * reaps, so an execution with no watchdog keeps its transcript until `DELETE /sessions/:id`.
 */
export const createFileSessionStore = (options: FileSessionStoreOptions = {}): SessionStore => {
  const dir = options.dir ?? join(process.cwd(), '.workerdeck', 'parked')
  // Encoded, not interpolated: an id is a runner-assigned string, and a '/' in one
  // would otherwise write outside `dir`.
  const fileFor = (id: string): string => join(dir, `${encodeURIComponent(id)}.json`)

  const read = async (path: string): Promise<StoredSessionRecord | null> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      // Absent is the ordinary case: nothing parked under that id. Anything else
      // (EACCES, EIO) is a session we cannot reach, and reporting it as "nothing
      // is parked" is how a restart guard ends up saying the coast is clear.
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
        if (isMissing(error)) {
          return []
        } // No directory yet: nothing has parked here.
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
            if (!record) {
              return null
            }
            // A record only answers `get`/`delete` under the name its id encodes to.
            // One that got here some other way (a copy, an ops rename) would list
            // forever and be unreachable — better to say so than to serve a ghost.
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
        // Missing is not an error — a discard racing a wake-up hits this.
        if (isMissing(error)) {
          return false
        }
        options.onError?.(error, { path, op: 'delete' })
        return false
      }
    },
  }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Shape-check a parsed file. A record missing any of these could not be rebuilt,
 * and half-restoring one is worse than skipping it. */
const parseRecord = (value: unknown): StoredSessionRecord | null => {
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
  // The discriminator is optional on the wire: every record written before
  // dormant sessions existed is a park, and those files must keep working
  // across the upgrade that introduced this.
  //
  // A `live` record deliberately falls through to the parked arm and passes it —
  // same fields, same requirements. That is what makes a *downgrade* graceful:
  // an older server reads the file, lists the session idle, and restores it once
  // (then consumes it, having no concept of refreshing in place). Losing
  // write-through on a downgrade is the right cost; refusing to parse the file
  // would lose the session.
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
