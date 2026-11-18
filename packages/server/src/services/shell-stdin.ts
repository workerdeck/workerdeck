import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type StdinFile = { path: string; remove: () => void }

// The wrapper's redirect opens the file before the login shell execs, so the open descriptor outlives the unlink.
export const STDIN_FILE_TTL_MS = 10_000

export async function writeStdinFile(data: string): Promise<StdinFile> {
  const dir = await mkdtemp(join(tmpdir(), 'workerdeck-stdin-'))
  const path = join(dir, 'stdin')
  let removed = false
  const remove = (): void => {
    if (removed) {
      return
    }
    removed = true
    clearTimeout(timer)
    rmSync(dir, { recursive: true, force: true })
  }
  const timer = setTimeout(remove, STDIN_FILE_TTL_MS)
  timer.unref()
  try {
    await writeFile(path, data, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    remove()
    throw error
  }
  return { path, remove }
}
