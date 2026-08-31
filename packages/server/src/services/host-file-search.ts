import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { entryKind } from './host-files.ts'

export const DEFAULT_IGNORED_DIRS = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.gradle',
  'Pods',
  'DerivedData',
  // Swift Package Manager: its object files carry the source names, so `@` answers `Transcript.o` before `Transcript.swift` without this.
  '.build',
]

export type FoundFile = {
  path: string
  relative: string
}

export type SearchResult = {
  matches: FoundFile[]
  truncated: boolean
}

export type SearchOptions = {
  query?: string
  limit?: number
  ignore?: readonly string[]
  maxScanned?: number
}

export function searchFiles(base: string, options: SearchOptions = {}): SearchResult {
  const limit = options.limit ?? 50
  const maxScanned = options.maxScanned ?? 20_000
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORED_DIRS)
  const needle = (options.query ?? '').toLowerCase()

  const found: { file: FoundFile; score: number; depth: number }[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }]
  let scanned = 0
  let exhausted = true

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++scanned > maxScanned) {
        exhausted = false
        queue.length = 0
        break
      }
      const kind = entryKind(entry)
      if (kind === 'dir') {
        if (!ignore.has(entry.name)) {
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
        }
        continue
      }
      if (kind !== 'file') {
        continue
      }
      const path = join(dir, entry.name)
      const rel = relative(base, path)
      const score = scoreMatch(rel, entry.name, needle)
      if (score !== null) {
        found.push({ file: { path, relative: rel }, score, depth })
      }
    }
  }

  found.sort(
    (a, b) =>
      b.score - a.score ||
      a.depth - b.depth ||
      a.file.relative.length - b.file.relative.length ||
      a.file.relative.localeCompare(b.file.relative),
  )
  return {
    matches: found.slice(0, limit).map((f) => f.file),
    truncated: !exhausted || found.length > limit,
  }
}

function scoreMatch(relativePath: string, name: string, needle: string): number | null {
  if (needle === '') {
    return 0
  }
  const inName = subsequenceScore(name.toLowerCase(), needle)
  if (inName !== null) {
    return inName + 1000
  }
  return subsequenceScore(relativePath.toLowerCase(), needle)
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let score = 0
  let from = 0
  let previous = -2
  for (const char of needle) {
    const at = haystack.indexOf(char, from)
    if (at === -1) {
      return null
    }
    if (at === previous + 1) {
      score += 8
    }
    if (at === 0) {
      score += 4
    }
    from = at + 1
    previous = at
  }
  // Shorter haystacks matched the same needle more tightly.
  return score - haystack.length / 100
}
