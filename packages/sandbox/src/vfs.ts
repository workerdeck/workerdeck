/**
 * Per-call in-memory scratch filesystem — never backed by host paths. A plain
 * path→content map on purpose: this package must run unpolyfilled in the
 * browser, and a node-flavored fs emulation drags `node:buffer` in with it.
 */
export type SandboxVfs = {
  read(path: string): string | undefined
  write(path: string, content: string): void
  /** File paths under `dir` (recursive), sorted. */
  list(dir?: string): string[]
  /** Full path → content map (e.g. to collect results after a run). */
  snapshot(): Record<string, string>
}

/** Collapse '.', '..' and empty segments into a rooted absolute path — the VFS
 * has no host backing to escape into, so this is path hygiene, not a sandbox. */
export const normalizeVfsPath = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}

export const createVfs = (seed?: Record<string, string>): SandboxVfs => {
  const files = new Map<string, string>()
  const write = (path: string, content: string): void => {
    files.set(normalizeVfsPath(path), content)
  }
  for (const [path, content] of Object.entries(seed ?? {})) {
    write(path, content)
  }
  return {
    read(path) {
      return files.get(normalizeVfsPath(path))
    },
    write,
    list(dir = '/') {
      const prefix = normalizeVfsPath(dir)
      return [...files.keys()].filter((file) => prefix === '/' || file === prefix || file.startsWith(prefix + '/')).sort()
    },
    snapshot() {
      return Object.fromEntries(files)
    },
  }
}
