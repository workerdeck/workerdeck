import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type MaterializedAuthKey = {
  key: string
  source: 'stored' | 'created' | 'ephemeral'
  path: string | null
}

function generateKey(): string {
  return randomBytes(24).toString('hex')
}

// One printable-ASCII line of at least 12 chars, so a truncated or garbage file regenerates rather than half-working.
function usableStoredKey(raw: string): string | null {
  const line = raw.split('\n', 1)[0]?.trim() ?? ''
  return line.length >= 12 && /^[\x21-\x7e]+$/.test(line) ? line : null
}

export async function materializeAuthKey(
  stateDir: string | null,
  options: { warn?: (message: string) => void } = {},
): Promise<MaterializedAuthKey> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[workerdeck] ${message}\n`))
  if (stateDir === null) {
    return { key: generateKey(), source: 'ephemeral', path: null }
  }

  const path = join(stateDir, 'auth-key')
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    raw = null
  }
  if (raw !== null) {
    const key = usableStoredKey(raw)
    if (key !== null) {
      try {
        const { mode } = await stat(path)
        if ((mode & 0o077) !== 0) {
          warn(`auth key file ${path} is readable by other users ` + `(mode ${(mode & 0o777).toString(8)}) — run: chmod 600 ${path}`)
        }
      } catch {}
      return { key, source: 'stored', path }
    }
  }

  const key = generateKey()
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(path, `${key}\n`, { mode: 0o600 })
  // writeFile's mode applies only on creation, so regenerating over a corrupt file would inherit its looser bits.
  await chmod(path, 0o600)
  return { key, source: 'created', path }
}
