import type { Dirent } from 'node:fs'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Containment core for the operator's host-filesystem routes (`/v1/fs/*`).
 *
 * The routes are operator privilege — gated by the auth key, outside the agent
 * permission flow — but the trees they expose are written BY the agent, so every
 * requested path is adversarial: a session can plant `root/notes -> ~/.ssh` and
 * wait for the operator's phone to browse into it. That is why `cwdAllowed` in
 * server.ts (resolve + prefix compare) is not reused here: it vets an
 * operator-typed cwd, where a lexical check is enough; here the *route* a path
 * takes matters, so containment is decided only on the realpath'd form.
 *
 * Disclosure policy: every refusal that consulted the filesystem is a uniform
 * `404 'not found'` — outside every root, escaping via symlink, dangling link,
 * and genuinely absent are indistinguishable. Anything finer would let a planted
 * link turn this API into an existence probe for paths outside the roots (403
 * iff `~/.ssh/id_rsa` exists). 403 is reserved for verdicts that reveal nothing
 * beyond the roots: malformed requests, and in-root targets of the wrong kind.
 *
 * TOCTOU: resolve-then-open is a race by construction and no check at this
 * layer closes it — between a resolve and the caller's open, the agent can swap
 * a verified component for a symlink. What resolve guarantees is that the
 * *returned* path was canonical and contained at resolve time. Callers must
 * open exactly `outcome.path` (never the requested string), preferably through
 * {@link readContained}/{@link writeContained}, which pin the final component
 * with O_NOFOLLOW, defuse fifo/device swaps with O_NONBLOCK + fstat-before-io,
 * and truncate only after the fd is proven to be a regular file. A *parent*
 * directory swapped inside the window can still redirect the open — closing
 * that needs openat2(RESOLVE_BENEATH), which Node does not expose. The window
 * is microseconds wide and the exposure is accepted and documented rather than
 * pretended away.
 */

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
export function createHostFileRoots(roots: string[]): HostFileRoots {
  return {
    roots: roots.map((configured) => {
      if (invalidRequest(configured)) {
        throw new Error(
          `createHostFileRoots: root must be an absolute path: ${JSON.stringify(configured)}`,
        )
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

/** The uniform filesystem refusal — see the disclosure policy in the header.
 * The string is deliberately constant: a distinct message is as much an oracle
 * as a distinct status. */
function notFound(): Refusal {
  return refuse(404, 'not found')
}

/** NUL is rejected before any fs call — Node throws a TypeError on NUL paths,
 * and that must surface as a refusal, not a 500. Relative paths are refused
 * outright rather than resolved against a cwd this API never promised. */
function invalidRequest(requested: string): boolean {
  return requested.length === 0 || requested.includes('\0') || !isAbsolute(requested)
}

/** Both sides are realpath output, so this is a pure lexical question — but a
 * bare prefix check gets the boundary wrong (`/x/app` would swallow
 * `/x/application`). `relative` answers it exactly: inside iff the walk from
 * root to candidate is empty or never has to leave through `..`. Exported for
 * the project-icon resolver (`project-info.ts`), which makes the same claim
 * against a project root; both callers must hand it realpath output only. */
export function contained(rootCanonical: string, candidate: string): boolean {
  const rel = relative(rootCanonical, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function rootContaining(roots: HostFileRoots, canonical: string): HostFileRoot | undefined {
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
export function resolveExisting(roots: HostFileRoots, requested: string): ResolveOutcome {
  if (invalidRequest(requested)) return refuse(403, 'invalid path')
  let canonical: string
  try {
    canonical = realpathSync(requested)
  } catch {
    // Absent, unreadable, looped, name-too-long — uniformly absent.
    return notFound()
  }
  const root = rootContaining(roots, canonical)
  if (!root) return notFound()
  let target
  try {
    // realpath output cannot name a symlink, so lstat === stat here modulo a
    // race; lstat anyway, so a swap inside the window classifies as neither
    // file nor dir and refuses.
    target = lstatSync(canonical)
  } catch {
    return notFound()
  }
  if (target.isFile()) return { ok: true, path: canonical, root: root.canonical, kind: 'file' }
  if (target.isDirectory()) return { ok: true, path: canonical, root: root.canonical, kind: 'dir' }
  // In-root fifo/device/socket: a 403 here reveals nothing beyond the roots
  // (the operator can list the entry anyway), and reading one would hang the
  // request or stream zeros forever.
  return refuse(403, 'not a regular file or directory')
}

/**
 * For write: the target may not exist, so realpath cannot be asked directly.
 * An existing target reuses read semantics — writing *through* a symlink that
 * canonicalizes inside a root is allowed (`root/link -> root/real.txt` edits
 * real.txt), same reasoning as {@link resolveExisting}. A missing target
 * canonicalizes its immediate parent and re-checks: only the final component
 * may be new, and anything already sitting there — in practice a dangling
 * symlink — is refused, because open(2) with O_CREAT follows it and would
 * create the file wherever it points. That refusal is `not found`, not 403: a
 * link to an existing outside file already answers 404 via the exists branch,
 * so a distinct status for the dangling case would hand back exactly the
 * existence bit the uniform 404 exists to withhold.
 */
export function resolveForWrite(roots: HostFileRoots, requested: string): ResolveOutcome {
  if (invalidRequest(requested)) return refuse(403, 'invalid path')
  try {
    const canonical = realpathSync(requested)
    const root = rootContaining(roots, canonical)
    if (!root) return notFound()
    const target = lstatSync(canonical)
    if (target.isDirectory()) return refuse(403, 'is a directory')
    if (!target.isFile()) return refuse(403, 'not a regular file')
    return { ok: true, path: canonical, root: root.canonical, kind: 'file' }
  } catch {
    // Target absent or unresolvable — fall through and try it as a create.
  }
  const base = basename(requested)
  if (base === '' || base === '.' || base === '..') return refuse(403, 'invalid path')
  let parent: string
  try {
    parent = realpathSync(dirname(requested))
  } catch {
    return notFound()
  }
  const root = rootContaining(roots, parent)
  if (!root) return notFound()
  try {
    // Parent exists but is not a directory (`root/file.txt/x`): no such
    // location, same answer as a missing parent.
    if (!lstatSync(parent).isDirectory()) return notFound()
  } catch {
    return notFound()
  }
  const path = join(parent, base)
  // basename() cannot smuggle a separator, so this re-check is redundant by
  // construction — kept because this is the line an escape would have to cross.
  if (!contained(root.canonical, path)) return notFound()
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
export function entryKind(entry: Dirent): HostEntryKind {
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  return 'other'
}

// win32 lacks O_NOFOLLOW/O_NONBLOCK (undefined at runtime despite the typing);
// there they contribute 0 and the fstat gates below stand alone.
const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0
const O_NONBLOCK: number = constants.O_NONBLOCK ?? 0

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
export function readContained(path: string): ReadOutcome {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? notFound() : refuse(403, 'refused')
  }
  try {
    if (!fstatSync(fd).isFile()) return refuse(403, 'not a regular file')
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
export function writeContained(path: string, data: string | Uint8Array): WriteOutcome {
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? notFound() : refuse(403, 'refused')
  }
  try {
    if (!fstatSync(fd).isFile()) return refuse(403, 'not a regular file')
    ftruncateSync(fd)
    writeFileSync(fd, data)
    return { ok: true }
  } catch {
    return refuse(403, 'refused')
  } finally {
    closeSync(fd)
  }
}
