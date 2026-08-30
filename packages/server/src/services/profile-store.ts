import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProfileInfo } from '@workerdeck/protocol'

/**
 * Where dashboard-managed profiles live. The seam exists for the same reason
 * `QueueAdapter` does: a single-host deployment wants the bundled file store and
 * no configuration, while an operator with a database wants their own.
 *
 * Profiles declared in `createWorkerServer({ profiles })` never enter a store —
 * they are code, and stay immutable. The store holds only what the management
 * routes created, and the two sets are unioned by name.
 *
 * A store holds NO credentials: `ProviderConfig.apiKeyEnv` is a variable name and
 * a Claude profile's `configDir` is a path. Both are resolved by the server's own
 * environment at session time, which is what keeps a stored profile safe to write
 * to disk and safe to serve from `GET /profiles`.
 */
export type ProfileStore = {
  /** Every stored profile. Called once at `listen()` and after each mutation. */
  list(): ProfileInfo[] | Promise<ProfileInfo[]>
  /** Create or replace by `profile.name`. */
  save(profile: ProfileInfo): void | Promise<void>
  /** Remove by name. Removing something absent is not an error. */
  delete(name: string): void | Promise<void>
}

/** Non-durable store for tests and ephemeral deployments. */
export function createMemoryProfileStore(seed: ProfileInfo[] = []): ProfileStore {
  const profiles = new Map(seed.map((p) => [p.name, p]))
  return {
    list: () => [...profiles.values()],
    save: (profile) => void profiles.set(profile.name, profile),
    delete: (name) => void profiles.delete(name),
  }
}

/**
 * JSON-file store: one array of profiles at `path` (default
 * `<cwd>/.workerdeck/profiles.json`). Writes go through a temp file and a
 * rename so a crash mid-write cannot truncate the operator's profile list.
 *
 * Single-process by design, exactly like the bundled queue adapter — two servers
 * sharing one file would race. That is what the seam is for.
 */
export function createFileProfileStore(path = join(process.cwd(), '.workerdeck', 'profiles.json')): ProfileStore {
  const read = (): Map<string, ProfileInfo> => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!Array.isArray(parsed)) {
        return new Map()
      }
      const profiles = parsed as ProfileInfo[]
      return new Map(profiles.filter((p) => p && typeof p.name === 'string').map((p) => [p.name, p]))
    } catch {
      // Absent or unparseable: start empty rather than refusing to boot. A
      // corrupt file is replaced on the next write, not silently merged into.
      return new Map()
    }
  }
  const write = (profiles: Map<string, ProfileInfo>): void => {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify([...profiles.values()], null, 2))
    renameSync(temp, path)
  }
  return {
    list: () => [...read().values()],
    save: (profile) => {
      const profiles = read()
      profiles.set(profile.name, profile)
      write(profiles)
    },
    delete: (name) => {
      const profiles = read()
      if (profiles.delete(name)) {
        write(profiles)
      }
    },
  }
}
