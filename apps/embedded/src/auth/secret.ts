import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

// `EMBEDDED_SECRET` is the deployment answer — replicas must agree on it. The file it falls back to is a credential:
// it mints a cookie for any user.
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
  // `writeFile`'s mode applies only when the file is created; an existing file keeps its own.
  chmodSync(path, 0o600)
  return secret
}
