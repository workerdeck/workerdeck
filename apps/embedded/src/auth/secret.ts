import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * The cookie-signing secret, which must outlive the process: a scoped session
 * 404s for anyone else, so a fresh secret on every boot signs everyone out and
 * leaves the restored conversations unreachable. `EMBEDDED_SECRET` (the
 * deployment answer — replicas must agree on it) else a 0600 file beside the
 * database. That file is a credential: it mints a cookie for any user.
 */
export const resolveSecret = (path: string): string => {
  const fromEnv = process.env.EMBEDDED_SECRET
  if (fromEnv) {
    return fromEnv
  }
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) {
      return existing
    }
  } catch {
    // Absent on a first run; anything else falls through to a write that reports it.
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  // `writeFile`'s mode is masked by the umask; an existing file keeps its own.
  chmodSync(path, 0o600)
  return secret
}
