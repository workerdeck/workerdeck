import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type HostLock = {
  pid: number
  port: number
  bindAddress: string
  url: string
  startedAt: number
}

export function lockPath(stateDir: string): string {
  return join(stateDir, 'vscode-host.json')
}

export function logPath(stateDir: string): string {
  return join(stateDir, 'vscode-host.log')
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists and belongs to someone else - still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readLock(stateDir: string): Promise<HostLock | undefined> {
  try {
    const raw = await readFile(lockPath(stateDir), 'utf8')
    const lock = JSON.parse(raw) as HostLock
    return typeof lock?.pid === 'number' && typeof lock.port === 'number' ? lock : undefined
  } catch {
    return undefined
  }
}

export async function writeLock(stateDir: string, lock: HostLock): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(lockPath(stateDir), `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
}

export async function clearLock(stateDir: string): Promise<void> {
  await rm(lockPath(stateDir), { force: true })
}

// The port is the real lock; this file only records who owns the process, so a window that did not
// start the server refuses to stop it. A lock whose pid is gone is a crash leftover and is cleared.
export async function ownedLock(stateDir: string): Promise<HostLock | undefined> {
  const lock = await readLock(stateDir)
  if (!lock) {
    return undefined
  }
  if (!pidAlive(lock.pid)) {
    await clearLock(stateDir)
    return undefined
  }
  return lock
}
