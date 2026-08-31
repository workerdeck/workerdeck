import type { Dirent } from 'node:fs'
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

// win32 lacks O_NOFOLLOW/O_NONBLOCK (undefined at runtime despite the typing): there they contribute 0 and the fstat gates stand alone.
const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0
const O_NONBLOCK: number = constants.O_NONBLOCK ?? 0

export type HostFileRoot = {
  readonly configured: string
  readonly canonical: string
}

export type HostFileRoots = { readonly roots: readonly HostFileRoot[] }

export function createHostFileRoots(roots: string[]): HostFileRoots {
  return {
    roots: roots.map((configured) => {
      if (invalidRequest(configured)) {
        throw new Error(`createHostFileRoots: root must be an absolute path: ${JSON.stringify(configured)}`)
      }
      let canonical: string
      try {
        canonical = realpathSync(configured)
      } catch {
        throw new Error(`createHostFileRoots: root does not exist: ${configured}`)
      }
      if (!lstatSync(canonical).isDirectory()) {
        throw new Error(`createHostFileRoots: root is not a directory: ${configured}`)
      }
      return { configured, canonical }
    }),
  }
}

export type ResolveOutcome =
  | { ok: true; path: string; root: string; kind: 'file' | 'dir' }
  | { ok: false; status: 403 | 404; error: string }

type Refusal = { ok: false; status: 403 | 404; error: string }

function refuse(status: 403 | 404, error: string): Refusal {
  return { ok: false, status, error }
}

function notFound(): Refusal {
  return refuse(404, 'not found')
}

// NUL is rejected before any fs call: Node throws a TypeError on one, and that must surface as a refusal rather than a 500.
function invalidRequest(requested: string): boolean {
  return requested.length === 0 || requested.includes('\0') || !isAbsolute(requested)
}

// A bare prefix check gets the boundary wrong (`/x/app` would swallow `/x/application`); both sides must be realpath output.
export function contained(rootCanonical: string, candidate: string): boolean {
  const rel = relative(rootCanonical, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function rootContaining(roots: HostFileRoots, canonical: string): HostFileRoot | undefined {
  return roots.roots.find((root) => contained(root.canonical, canonical))
}

export function resolveExisting(roots: HostFileRoots, requested: string): ResolveOutcome {
  if (invalidRequest(requested)) {
    return refuse(403, 'invalid path')
  }
  let canonical: string
  try {
    canonical = realpathSync(requested)
  } catch {
    return notFound()
  }
  const root = rootContaining(roots, canonical)
  if (!root) {
    return notFound()
  }
  let target
  try {
    // realpath output cannot name a symlink, so lstat === stat modulo a race — and a swap inside the window then classifies as neither.
    target = lstatSync(canonical)
  } catch {
    return notFound()
  }
  if (target.isFile()) {
    return { ok: true, path: canonical, root: root.canonical, kind: 'file' }
  }
  if (target.isDirectory()) {
    return { ok: true, path: canonical, root: root.canonical, kind: 'dir' }
  }
  return refuse(403, 'not a regular file or directory')
}

// Only the final component may be new: a missing target canonicalizes its parent, so a dangling symlink sitting there is refused, not created through.
export function resolveForWrite(roots: HostFileRoots, requested: string): ResolveOutcome {
  if (invalidRequest(requested)) {
    return refuse(403, 'invalid path')
  }
  try {
    const canonical = realpathSync(requested)
    const root = rootContaining(roots, canonical)
    if (!root) {
      return notFound()
    }
    const target = lstatSync(canonical)
    if (target.isDirectory()) {
      return refuse(403, 'is a directory')
    }
    if (!target.isFile()) {
      return refuse(403, 'not a regular file')
    }
    return { ok: true, path: canonical, root: root.canonical, kind: 'file' }
  } catch {}
  const base = basename(requested)
  if (base === '' || base === '.' || base === '..') {
    return refuse(403, 'invalid path')
  }
  let parent: string
  try {
    parent = realpathSync(dirname(requested))
  } catch {
    return notFound()
  }
  const root = rootContaining(roots, parent)
  if (!root) {
    return notFound()
  }
  try {
    if (!lstatSync(parent).isDirectory()) {
      return notFound()
    }
  } catch {
    return notFound()
  }
  const path = join(parent, base)
  // Redundant by construction (basename() cannot smuggle a separator) — kept because this is the line an escape would have to cross.
  if (!contained(root.canonical, path)) {
    return notFound()
  }
  try {
    lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, path, root: root.canonical, kind: 'file' }
    }
    return notFound()
  }
  return notFound()
}

export type HostEntryKind = 'file' | 'dir' | 'symlink' | 'other'

export function entryKind(entry: Dirent): HostEntryKind {
  if (entry.isSymbolicLink()) {
    return 'symlink'
  }
  if (entry.isFile()) {
    return 'file'
  }
  if (entry.isDirectory()) {
    return 'dir'
  }
  return 'other'
}

export type ReadOutcome = { ok: true; data: Buffer } | Refusal

export function readContained(path: string): ReadOutcome {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? notFound() : refuse(403, 'refused')
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return refuse(403, 'not a regular file')
    }
    return { ok: true, data: readFileSync(fd) }
  } catch {
    return refuse(403, 'refused')
  } finally {
    closeSync(fd)
  }
}

export type WriteOutcome = { ok: true } | Refusal

export function writeContained(path: string, data: string | Uint8Array): WriteOutcome {
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? notFound() : refuse(403, 'refused')
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return refuse(403, 'not a regular file')
    }
    ftruncateSync(fd)
    writeFileSync(fd, data)
    return { ok: true }
  } catch {
    return refuse(403, 'refused')
  } finally {
    closeSync(fd)
  }
}
