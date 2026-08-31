import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProjectIcon, ProjectInfo, SessionInfo } from '@workerdeck/protocol'
import { contained, readContained } from './host-files.ts'

/**
 * Project identity discovery: the `.workerdeck.json` ancestor walk behind `SessionInfo.project`,
 * and the read side of `GET /sessions/:id/project/icon`. Stamped at **serve time**, never
 * persisted, and TTL-cached per cwd (negative results too — `GET /sessions` polls at 1.2s).
 *
 * Every failure degrades to "no project" and the walk *continues* past a broken file, so a bad
 * `.workerdeck.json` in a subdirectory cannot shadow the root's good one. The icon is the
 * security surface — its path comes out of a file the agent can write — so containment is
 * `host-files.ts`' realpath rule, never `cwdAllowed`. See `docs/PACKAGES.md` §`packages/server`
 * and `docs/GOTCHAS.md` §Host filesystem.
 */

const PROJECT_FILE = '.workerdeck.json'
/** A config file, not a document — anything bigger is skipped as malformed. */
const MAX_PROJECT_FILE_BYTES = 64 * 1024
/** An icon is rendered at list-row size; half a megabyte is already generous,
 * and this route buffers (no stream), so the cap bounds gateway heap too. */
export const MAX_PROJECT_ICON_BYTES = 512 * 1024
/** Display name clip — a list row's width, not a document's. */
const MAX_NAME_CHARS = 80
/** lucide's naming: lowercase kebab-case. Shape-only — the gateway has no icon
 * catalog and must not grow one; an unknown-but-well-formed name ships and the
 * client falls back (a stale row, never withheld state). */
const GLYPH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const DEFAULT_TTL_MS = 30_000
/** Sweep threshold: above this many cached cwds, expired entries are evicted
 * on the next resolve so dead sessions' keys do not accumulate forever. */
const SWEEP_ABOVE = 256

type IconMediaType = 'image/png' | 'image/svg+xml'

/** What the icon route serves from — held server-side only; the wire carries
 * the `ProjectIcon` address, never the path. */
export type ResolvedProjectIcon = { path: string; mediaType: IconMediaType; hash: string }

type Resolution = {
  project?: ProjectInfo
  icon?: ResolvedProjectIcon
  expiresAt: number
}

export class ProjectInfoService {
  readonly #ttlMs: number
  readonly #byCwd = new Map<string, Resolution>()

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  /**
   * The serve-time decoration: `info` with `project` stamped on, or the same
   * object untouched when there is nothing to add — the common case on a list
   * poll, so no allocation for it (replaySlice's same-object rule).
   */
  withProject(info: SessionInfo): SessionInfo {
    if (!info.cwd) {
      return info
    }
    const project = this.#resolve(info.cwd).project
    return project ? { ...info, project } : info
  }

  /** The icon route's read side: the canonical, contained icon file for this
   * session's cwd — resolved from the gateway's own cache, never from anything
   * the client named. Undefined = no project, no icon, or an icon refused. */
  iconFor(cwd: string): ResolvedProjectIcon | undefined {
    if (!cwd) {
      return undefined
    }
    return this.#resolve(cwd).icon
  }

  #resolve(cwd: string): Resolution {
    const now = Date.now()
    const held = this.#byCwd.get(cwd)
    if (held && held.expiresAt > now) {
      return held
    }
    if (this.#byCwd.size > SWEEP_ABOVE) {
      for (const [key, entry] of this.#byCwd) {
        if (entry.expiresAt <= now) {
          this.#byCwd.delete(key)
        }
      }
    }
    const fresh = { ...discover(cwd), expiresAt: now + this.#ttlMs }
    this.#byCwd.set(cwd, fresh)
    return fresh
  }
}

/** The ancestor walk: realpath the cwd (a lexical walk over `/tmp/x` would
 * miss the file at `/private/tmp/x`, and canonicalizing here is what makes
 * `root` — the grouping key — spell identically for every cwd inside one
 * project), then nearest `.workerdeck.json` wins, to the filesystem root. */
const discover = (cwd: string): Omit<Resolution, 'expiresAt'> => {
  // A relative cwd would realpath against the gateway process's own cwd and
  // walk *its* ancestry — refused outright, like host-files' invalidRequest.
  if (!isAbsolute(cwd) || cwd.includes('\0')) {
    return {}
  }
  let dir: string
  try {
    dir = realpathSync(cwd)
  } catch {
    return {} // cwd gone or unreadable — a session must still serve.
  }
  for (;;) {
    const found = tryLoad(join(dir, PROJECT_FILE), dir)
    if (found) {
      return found
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return {}
    }
    dir = parent
  }
}

/** One directory's verdict: a project record, or undefined to keep walking —
 * which is the same answer for "absent" and for every malformed shape. */
const tryLoad = (file: string, root: string): Omit<Resolution, 'expiresAt'> | undefined => {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    return undefined
  }
  // A symlinked project file is skipped, not followed — the agent writes this
  // tree, and `readContained`'s O_NOFOLLOW would refuse it below anyway; a
  // directory of that name is nothing either.
  if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) {
    return undefined
  }
  const read = readContained(file)
  if (!read.ok) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.data.toString('utf8'))
  } catch {
    return undefined // Malformed JSON: cannot even tell it is ours — walk on.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const raw = parsed as { name?: unknown; icon?: unknown }
  // A parsed object IS the project marker, whatever its fields hold: `{}` is a
  // valid declaration of "this directory is the root", named by its basename.
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME_CHARS) : basename(root)
  const icon = classifyIcon(raw.icon, root)
  return {
    project: { name, root, ...(icon ? { icon: icon.wire } : {}) },
    ...(icon?.resolved ? { icon: icon.resolved } : {}),
  }
}

/**
 * The one-string icon rule (documented on protocol's `ProjectInfo`): ends in
 * `.png`/`.svg` → repo-relative image path, else lucide-shaped glyph name,
 * else ignored. Total and collision-free — a glyph name contains no dot.
 */
const classifyIcon = (value: unknown, root: string): { wire: ProjectIcon; resolved?: ResolvedProjectIcon } | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const declared = value.trim()
  if (!declared || declared.includes('\0') || declared.length > 512) {
    return undefined
  }
  const lower = declared.toLowerCase()
  const mediaType: IconMediaType | undefined = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.svg') ? 'image/svg+xml' : undefined
  if (!mediaType) {
    if (!GLYPH_RE.test(declared) || declared.length > 64) {
      return undefined
    }
    return { wire: { type: 'glyph', name: declared } }
  }
  // An image path. Relative only — the file is checked into a repo that clones
  // onto other machines, so an absolute path is wrong by construction (and
  // refusing it early keeps the containment check from ever seeing one).
  // Backslashes are refused rather than translated: repo paths are posix.
  if (isAbsolute(declared) || declared.includes('\\')) {
    return undefined
  }
  let canonical: string
  try {
    canonical = realpathSync(resolve(root, declared))
  } catch {
    return undefined // Absent, dangling, looped — uniformly no icon.
  }
  // Containment on the canonical form only: this refuses `..` escapes and
  // planted symlinks by the same one check. `root` is realpath output by
  // construction (the walk starts from a realpath'd cwd).
  if (!contained(root, canonical)) {
    return undefined
  }
  let stat
  try {
    stat = lstatSync(canonical)
  } catch {
    return undefined
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PROJECT_ICON_BYTES) {
    return undefined
  }
  // Hashed at discovery because the wire carries it: the client's cross-session
  // cache key and the route's ETag. One bounded read per project per TTL.
  const read = readContained(canonical)
  if (!read.ok || read.data.length > MAX_PROJECT_ICON_BYTES) {
    return undefined
  }
  const hash = createHash('sha256').update(read.data).digest('hex')
  return {
    wire: { type: 'image', mediaType, hash },
    resolved: { path: canonical, mediaType, hash },
  }
}
