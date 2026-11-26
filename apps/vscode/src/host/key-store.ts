import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// `<state-dir>/auth-key` is the one key store, shared with a CLI started on the same state dir. Same validity rule as
// the CLI's `auth-key.ts`, so a file one of them accepts the other accepts too.
export function authKeyPath(stateDir: string): string {
  return join(stateDir, 'auth-key')
}

export async function readStateKey(stateDir: string): Promise<string | undefined> {
  try {
    const line = (await readFile(authKeyPath(stateDir), 'utf8')).split('\n', 1)[0]?.trim() ?? ''
    return line.length >= 12 && /^[\x21-\x7e]+$/.test(line) ? line : undefined
  } catch {
    return undefined
  }
}

export async function writeStateKey(stateDir: string, key: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = authKeyPath(stateDir)
  await writeFile(path, `${key}\n`, { mode: 0o600 })
  // writeFile's mode applies only on creation.
  await chmod(path, 0o600)
}

export function generateKey(): string {
  return randomBytes(24).toString('base64url')
}
