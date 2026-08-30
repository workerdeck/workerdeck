import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CliSessionStore, StoredSession } from './auth.ts'

/**
 * Durable browser-login sessions for the turnkey CLI. What lands on disk is not
 * credential material — `createCliAuth` keys its table by `HMAC-SHA256(secret,
 * token)`, which is also what makes key rotation invalidate every outstanding
 * cookie for free (`docs/GOTCHAS.md` §Server, profiles & auth).
 *
 * Every failure is a warning, never a throw: losing durability signs the
 * operator out, losing the gateway does much worse.
 */

const FORMAT_VERSION = 1
const FILE_NAME = 'auth-sessions.json'

export type AuthSessionStoreOptions = {
  /** Where `<stateDir>/auth-sessions.json` lives. */
  stateDir: string
  /** Defaults to a `[workerdeck]` line on stderr. */
  warn?: (message: string) => void
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

type FileShape = { version: number; sessions: [string, number][] }

const parseSessions = (raw: string, now: number): [string, StoredSession][] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const file = parsed as Partial<FileShape>
  if (file?.version !== FORMAT_VERSION || !Array.isArray(file.sessions)) {
    return []
  }
  const entries: [string, StoredSession][] = []
  for (const entry of file.sessions) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue
    }
    const [key, expiresAt] = entry
    if (typeof key !== 'string' || key === '') {
      continue
    }
    // Expired entries drop on load rather than being carried and swept later:
    // the cap they would otherwise occupy is the operator's own login budget.
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) {
      continue
    }
    entries.push([key, { expiresAt }])
  }
  return entries
}

export const createAuthSessionStore = async (options: AuthSessionStoreOptions): Promise<CliSessionStore> => {
  const now = options.now ?? Date.now
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[workerdeck] ${message}\n`))
  const path = join(options.stateDir, FILE_NAME)

  let initial: [string, StoredSession][] = []
  try {
    const raw = await readFile(path, 'utf8')
    initial = parseSessions(raw, now())
    try {
      const { mode } = await stat(path)
      if ((mode & 0o077) !== 0) {
        warn(`session file ${path} is readable by other users ` + `(mode ${(mode & 0o777).toString(8)}) — run: chmod 600 ${path}`)
      }
    } catch {
      // stat failing after a successful read is exotic; the table still works.
    }
  } catch {
    initial = [] // Missing, unreadable and corrupt all mean "start empty".
  }

  // One chain, so two mutations in the same tick cannot interleave their
  // writes and land the older table last.
  let pending: Promise<void> = Promise.resolve()
  let warned = false

  const write = async (entries: [string, StoredSession][]): Promise<void> => {
    const body: FileShape = { version: FORMAT_VERSION, sessions: entries.map(([key, s]) => [key, s.expiresAt]) }
    const tmp = `${path}.${process.pid}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
      // `writeFile`'s mode applies only on creation — a reused temp path must
      // not inherit whatever bits an earlier run left on it.
      await chmod(tmp, 0o600)
      await rename(tmp, path)
      warned = false
    } catch (error) {
      // Warn once per outage, not once per login: a read-only state dir would
      // otherwise print on every request that touches the table.
      if (!warned) {
        warned = true
        warn(`could not persist browser logins to ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    initial,
    save(entries) {
      pending = pending.then(() => write(entries))
    },
    flush: () => pending,
  }
}
