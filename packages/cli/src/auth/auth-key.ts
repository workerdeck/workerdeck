import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Materializes the key `resolveInstanceConfig` promised via `generateAuthKey`.
 * Returns a usable secret or throws — never "no key": the resolved config has
 * already stood the Host-header guard down on the strength of that promise, so
 * a silent miss would serve an open gateway wearing an authenticated banner
 * (`docs/GOTCHAS.md` §Server, profiles & auth). This is the gateway's own
 * operator secret and nothing else — no model-provider credential passes here.
 */
export type MaterializedAuthKey = {
  key: string
  /** 'stored' reused the file, 'created' wrote a new one, 'ephemeral' had nowhere to write. */
  source: 'stored' | 'created' | 'ephemeral'
  /** Where the key lives, or null when ephemeral. */
  path: string | null
}

/** 48 hex chars — far past `createCliAuth`'s 12-char floor, and header-safe. */
const generateKey = (): string => randomBytes(24).toString('hex')

/** One printable-ASCII line, header-safe: a truncated or garbage file regenerates rather than half-working. */
const usableStoredKey = (raw: string): string | null => {
  const line = raw.split('\n', 1)[0]?.trim() ?? ''
  return line.length >= 12 && /^[\x21-\x7e]+$/.test(line) ? line : null
}

export const materializeAuthKey = async (
  stateDir: string | null,
  options: { warn?: (message: string) => void } = {},
): Promise<MaterializedAuthKey> => {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[workerdeck] ${message}\n`))
  if (stateDir === null) {
    return { key: generateKey(), source: 'ephemeral', path: null }
  }

  const path = join(stateDir, 'auth-key')
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    raw = null // Missing and unreadable land in the same place: generate fresh.
  }
  if (raw !== null) {
    const key = usableStoredKey(raw)
    if (key !== null) {
      try {
        const { mode } = await stat(path)
        if ((mode & 0o077) !== 0) {
          warn(`auth key file ${path} is readable by other users ` + `(mode ${(mode & 0o777).toString(8)}) — run: chmod 600 ${path}`)
        }
      } catch {
        // stat failing after a successful read is exotic; the key still works.
      }
      return { key, source: 'stored', path }
    }
  }

  const key = generateKey()
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(path, `${key}\n`, { mode: 0o600 })
  // writeFile's mode applies only on creation — regenerating over a corrupt
  // file must not inherit whatever loose bits the corrupt one had.
  await chmod(path, 0o600)
  return { key, source: 'created', path }
}
