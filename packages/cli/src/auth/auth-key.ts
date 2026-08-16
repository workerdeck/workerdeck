import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Materializes the key that `resolveInstanceConfig` promised via
 * `generateAuthKey`: resolution is pure and synchronous, reading a key file is
 * I/O, so the two halves meet here at startup. The contract is that this
 * function returns a usable secret or throws — it never returns "no key",
 * because the resolved config has already stood down the Host-header guard on
 * the strength of the promise, and a silent miss would serve an open gateway
 * that reports itself authenticated.
 *
 * The key persists under `stateDir` so a restart does not un-pair every client
 * that stored it (the iOS app keeps it in its keychain). No `stateDir` means
 * nothing durable to write, so the key is ephemeral per run — the banner says
 * so. This is the gateway's own operator secret and nothing else: Anthropic
 * credentials never pass through here (root CLAUDE.md, auth red lines).
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

/** A stored key must be one printable-ASCII line long enough to be a secret:
 * both transports (HTTP header, login form) choke on anything else, and a
 * truncated or garbage file should regenerate, not crash or half-work. */
const usableStoredKey = (raw: string): string | null => {
  const line = raw.split('\n', 1)[0]?.trim() ?? ''
  return line.length >= 12 && /^[\x21-\x7e]+$/.test(line) ? line : null
}

export async function materializeAuthKey(
  stateDir: string | null,
  options: { warn?: (message: string) => void } = {},
): Promise<MaterializedAuthKey> {
  const warn =
    options.warn ?? ((message: string) => process.stderr.write(`[workerdeck] ${message}\n`))
  if (stateDir === null) return { key: generateKey(), source: 'ephemeral', path: null }

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
          warn(
            `auth key file ${path} is readable by other users ` +
              `(mode ${(mode & 0o777).toString(8)}) — run: chmod 600 ${path}`,
          )
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
