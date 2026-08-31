import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProjectIcon, ProjectInfo, SessionInfo } from '@workerdeck/protocol'
import { contained, readContained } from './host-files.ts'

const PROJECT_FILE = '.workerdeck.json'
const MAX_PROJECT_FILE_BYTES = 64 * 1024
export const MAX_PROJECT_ICON_BYTES = 512 * 1024
const MAX_NAME_CHARS = 80
const GLYPH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const DEFAULT_TTL_MS = 30_000
const SWEEP_ABOVE = 256

type IconMediaType = 'image/png' | 'image/svg+xml'

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

  withProject(info: SessionInfo): SessionInfo {
    if (!info.cwd) {
      return info
    }
    const project = this.#resolve(info.cwd).project
    return project ? { ...info, project } : info
  }

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

function discover(cwd: string): Omit<Resolution, 'expiresAt'> {
  if (!isAbsolute(cwd) || cwd.includes('\0')) {
    return {}
  }
  let dir: string
  try {
    dir = realpathSync(cwd)
  } catch {
    return {}
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

function tryLoad(file: string, root: string): Omit<Resolution, 'expiresAt'> | undefined {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    return undefined
  }
  // A symlinked project file is skipped, not followed — the agent writes this tree.
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
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const raw = parsed as { name?: unknown; icon?: unknown }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME_CHARS) : basename(root)
  const icon = classifyIcon(raw.icon, root)
  return {
    project: { name, root, ...(icon ? { icon: icon.wire } : {}) },
    ...(icon?.resolved ? { icon: icon.resolved } : {}),
  }
}

function classifyIcon(value: unknown, root: string): { wire: ProjectIcon; resolved?: ResolvedProjectIcon } | undefined {
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
  if (isAbsolute(declared) || declared.includes('\\')) {
    return undefined
  }
  let canonical: string
  try {
    canonical = realpathSync(resolve(root, declared))
  } catch {
    return undefined
  }
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
