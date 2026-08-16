import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * The cookie-signing secret, kept across restarts.
 *
 * A per-process random secret is the obvious default and it quietly breaks the
 * one thing this app exists to demonstrate. Sessions survive a restart now
 * (`parking.persistLive`), but the cookie that says *who you are* is what
 * decides whether you can see them — the gateway answers 404 for another
 * principal's session — so a fresh secret on every boot signs everyone out and
 * they come back to an empty sidebar with their conversations intact and
 * unreachable. The restored session is there; nothing can prove it is yours.
 *
 * So: `EMBEDDED_SECRET` if the operator set one (the deployment answer — several
 * replicas must agree on it, and it belongs in a secret manager), else one
 * generated once and kept beside the database, 0600. That file is a credential:
 * anyone holding it can mint a cookie for any user.
 */
export function resolveSecret(path: string): string {
  const fromEnv = process.env.EMBEDDED_SECRET
  if (fromEnv) return fromEnv
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    // Absent is the ordinary case on a first run; anything else falls through to
    // a write that will report the real problem.
  }
  const secret = randomBytes(32).toString('hex')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  // `writeFile`'s mode is masked by the umask; an existing file keeps its own.
  chmodSync(path, 0o600)
  return secret
}
