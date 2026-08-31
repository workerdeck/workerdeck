export type SandboxVfs = {
  read(path: string): string | undefined
  write(path: string, content: string): void
  list(dir?: string): string[]
  snapshot(): Record<string, string>
}

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
