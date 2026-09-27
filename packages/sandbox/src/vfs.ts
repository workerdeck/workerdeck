export type SandboxVfs = {
  read(path: string): string | undefined
  write(path: string, content: string): void
  list(dir?: string): string[]
  snapshot(): Record<string, string>
}

// Sizes are UTF-8 bytes. The guest's own memory limit bounds one string, not how many it copies into this host-side map.
export type VfsLimits = {
  maxFileBytes?: number
  maxFiles?: number
  maxTotalBytes?: number
}

export const DEFAULT_VFS_LIMITS: Required<VfsLimits> = {
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 1000,
  maxTotalBytes: 32 * 1024 * 1024,
}

export function normalizeVfsPath(path: string): string {
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

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i++
    } else {
      bytes += 3
    }
  }
  return bytes
}

// The seed is the host's and is never refused, but it counts against the totals a later write has to fit under.
export function createVfs(seed?: Record<string, string>, limits: VfsLimits = {}): SandboxVfs {
  const { maxFileBytes, maxFiles, maxTotalBytes } = { ...DEFAULT_VFS_LIMITS, ...limits }
  const files = new Map<string, string>()
  const sizes = new Map<string, number>()
  let totalBytes = 0
  const store = (path: string, content: string, size: number): void => {
    totalBytes += size - (sizes.get(path) ?? 0)
    files.set(path, content)
    sizes.set(path, size)
  }
  for (const [path, content] of Object.entries(seed ?? {})) {
    store(normalizeVfsPath(path), content, utf8ByteLength(content))
  }
  const write = (rawPath: string, content: string): void => {
    const path = normalizeVfsPath(rawPath)
    if (content.length > maxFileBytes) {
      throw new RangeError(`vfs: ${path} exceeds the ${maxFileBytes}-byte per-file limit`)
    }
    const size = utf8ByteLength(content)
    if (size > maxFileBytes) {
      throw new RangeError(`vfs: ${path} is ${size} bytes, over the ${maxFileBytes}-byte per-file limit`)
    }
    const existing = sizes.get(path)
    if (existing === undefined && files.size >= maxFiles) {
      throw new RangeError(`vfs: cannot create ${path}, the ${maxFiles}-file limit is reached`)
    }
    if (totalBytes - (existing ?? 0) + size > maxTotalBytes) {
      throw new RangeError(`vfs: writing ${path} would exceed the ${maxTotalBytes}-byte total limit`)
    }
    store(path, content, size)
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
