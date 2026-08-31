import type { Dirent } from 'node:fs'
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Containment core for the operator's host-filesystem routes (`/v1/fs/*`). Every requested path
 * is adversarial — the trees are written by the agent — so three rules hold, and
 * `docs/GOTCHAS.md` §Host filesystem says why each one is not negotiable:
 *
 * - **Containment is decided only on the realpath'd form**, never `cwdAllowed`'s lexical compare.
 * - **Every refusal that consulted the filesystem is a uniform `404 'not found'`**; 403 is
 *   reserved for verdicts that reveal nothing beyond the roots.
 * - **Callers open exactly `outcome.path`**, through {@link readContained}/{@link writeContained}
 *   — resolve-time guarantees hold at resolve time only, and a swapped parent stays a known,
 *   accepted race (it needs openat2(RESOLVE_BENEATH), which Node does not expose).
 */

// win32 lacks O_NOFOLLOW/O_NONBLOCK (undefined at runtime despite the typing);
// there they contribute 0 and the fstat gates below stand alone.
const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0
const O_NONBLOCK: number = constants.O_NONBLOCK ?? 0

export type HostFileRoot = {
  /** The operator's spelling, kept for display (`GET /v1/fs/roots`). */
  readonly configured: string
  /** What containment is checked against — and the prefix `ResolveOutcome.path`
   * is guaranteed to carry, so relative display paths are computed from this. */
  readonly canonical: string
}

export type HostFileRoots = { readonly roots: readonly HostFileRoot[] }

/**
 * Built once at startup from operator config. Roots are canonicalized here
 * because resolution produces realpath'd targets: a root that is itself a
 * symlink (`/tmp` -> `/private/tmp` on macOS) would otherwise contain nothing.
 * A misdeclared root throws rather than silently guarding the wrong tree —
 * same stance as profile config dirs in server.ts. An empty list is legal and
 * refuses everything; "no roots means allow all" is `cwdAllowed`'s contract,
 * never this module's.
 */
export const createHostFileRoots = (roots: string[]): HostFileRoots => {
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

const refuse = (status: 403 | 404, error: string): Refusal => {
  return { ok: false, status, error }
}

/** The uniform filesystem refusal — see the disclosure policy in the header.
 * The string is deliberately constant: a distinct message is as much an oracle
 * as a distinct status. */
const notFound = (): Refusal => {
  return refuse(404, 'not found')
}

/** NUL is rejected before any fs call — Node throws a TypeError on NUL paths,
 * and that must surface as a refusal, not a 500. Relative paths are refused
 * outright rather than resolved against a cwd this API never promised. */
const invalidRequest = (requested: string): boolean => {
  return requested.length === 0 || requested.includes('\0') || !isAbsolute(requested)
}

/** Both sides are realpath output, so this is a pure lexical question — but a
 * bare prefix check gets the boundary wrong (`/x/app` would swallow
 * `/x/application`). `relative` answers it exactly: inside iff the walk from
 * root to candidate is empty or never has to leave through `..`. Exported for
 * the project-icon resolver (`project-info.ts`), which makes the same claim
 * against a project root; both callers must hand it realpath output only. */
export const contained = (rootCanonical: string, candidate: string): boolean => {
  const rel = relative(rootCanonical, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const rootContaining = (roots: HostFileRoots, canonical: string): HostFileRoot | undefined => {
  return roots.roots.find((root) => contained(root.canonical, canonical))
}

/**
 * For read/list: the target must exist. realpath is handed the request whole —
 * no lexical `..` collapsing first, because `root/link/..` is lexically `root`
 * but physically the link target's parent, and only the physical answer is the
 * true one. Symlinks that canonicalize *inside* a root are followed and served:
 * containment is a property of the canonical target, not of the route to it —
 * the operator granted the whole subtree, so nothing new becomes reachable.
 */
export const resolveExisting = (roots: HostFileRoots, requested: string): ResolveOutcome => {
  if (invalidRequest(requested)) {
    return refuse(403, 'invalid path')
  }
  let canonical: string
  try {
    canonical = realpathSync(requested)
  } catch {
    // Absent, unreadable, looped, name-too-long — uniformly absent.
    return notFound()
  }
  const root = rootContaining(roots, canonical)
  if (!root) {
    return notFound()
  }
  let target
  try {
    // realpath output cannot name a symlink, so lstat === stat here modulo a
    // race; lstat anyway, so a swap inside the window classifies as neither
    // file nor dir and refuses.
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
  // In-root fifo/device/socket: a 403 here reveals nothing beyond the roots
  // (the operator can list the entry anyway), and reading one would hang the
  // request or stream zeros forever.
  return refuse(403, 'not a regular file or directory')
}

/**
 * For write: the target may not exist, so realpath cannot be asked directly. An existing target
 * reuses {@link resolveExisting}'s semantics; a missing one canonicalizes its immediate parent, so
 * **only the final component may be new** and anything already sitting there (a dangling symlink,
 * which O_CREAT would follow) is refused — as `not found`, keeping the uniform-404 disclosure.
 */
export const resolveForWrite = (roots: HostFileRoots, requested: string): ResolveOutcome => {
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
  } catch {
    // Target absent or unresolvable — fall through and try it as a create.
  }
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
    // Parent exists but is not a directory (`root/file.txt/x`): no such
    // location, same answer as a missing parent.
    if (!lstatSync(parent).isDirectory()) {
      return notFound()
    }
  } catch {
    return notFound()
  }
  const path = join(parent, base)
  // basename() cannot smuggle a separator, so this re-check is redundant by
  // construction — kept because this is the line an escape would have to cross.
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
  // Something IS at the final component even though realpath(requested) failed:
  // a dangling symlink, or a concurrent create. Refuse both — see the header.
  return notFound()
}

export type HostEntryKind = 'file' | 'dir' | 'symlink' | 'other'

/** lstat semantics on purpose: a listing shows a symlink AS a symlink — the
 * server never follows one while rendering a directory. Following happens only
 * when the entry is itself requested, through {@link resolveExisting}, which
 * refuses it if it escapes. `readdir(withFileTypes)` already answers without
 * following, so this is classification, not I/O. */
export const entryKind = (entry: Dirent): HostEntryKind => {
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

/**
 * The open half of the resolve→open discipline; pass `ResolveOutcome.path`,
 * never the requested string. O_NOFOLLOW turns a final component swapped for a
 * symlink inside the race window into ELOOP instead of a follow; O_NONBLOCK
 * makes a swapped-in fifo open instantly instead of parking the request until a
 * writer appears (it is inert for regular files); the fstat gate refuses
 * anything that is not a plain file before a byte is read — `/dev/zero` would
 * otherwise be an unbounded read.
 */
export const readContained = (path: string): ReadOutcome => {
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

/**
 * O_CREAT|O_NOFOLLOW refuses (ELOOP) a symlink planted at the final component
 * after resolve — the exact swap that would land the write at the link's
 * target. Truncation happens via ftruncate only AFTER the fd is proven to be a
 * regular file, so a swapped-in device or fifo is never truncated or written;
 * O_NONBLOCK turns the reader-less-fifo open from a hang into ENXIO.
 */
export const writeContained = (path: string, data: string | Uint8Array): WriteOutcome => {
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
