import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type JsonWriteOptions = { indent?: number; trailingNewline?: boolean }

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

// `writeFile`'s mode applies only on creation, so the chmod is what keeps a temp name left over by an earlier run from
// handing its looser bits to the renamed file.
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const temp = tempPathFor(path)
  await writeFile(temp, data, { mode: FILE_MODE })
  await chmod(temp, FILE_MODE)
  await rename(temp, path)
}

export function writeFileAtomicSync(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  const temp = tempPathFor(path)
  writeFileSync(temp, data, { mode: FILE_MODE })
  chmodSync(temp, FILE_MODE)
  renameSync(temp, path)
}

export function writeJsonAtomic(path: string, value: unknown, options: JsonWriteOptions = {}): Promise<void> {
  return writeFileAtomic(path, serializeJson(value, options))
}

export function writeJsonAtomicSync(path: string, value: unknown, options: JsonWriteOptions = {}): void {
  writeFileAtomicSync(path, serializeJson(value, options))
}

// Missing, unreadable and corrupt all read as the fallback; a caller that must tell them apart reads the file itself.
export async function readJsonOr(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return fallback
  }
}

export function readJsonOrSync(path: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return fallback
  }
}

function tempPathFor(path: string): string {
  return `${path}.${process.pid}.tmp`
}

function serializeJson(value: unknown, options: JsonWriteOptions): string {
  const text = JSON.stringify(value, null, options.indent)
  return options.trailingNewline ? `${text}\n` : text
}
