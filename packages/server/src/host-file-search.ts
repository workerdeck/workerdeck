import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { entryKind } from './host-files.ts'

/**
 * The recursive half of the host-file routes: what `@file` autocomplete needs and
 * `/fs/list` deliberately isn't. Listing answers "what is in this directory"; this
 * answers "which file in this tree did you mean", which is a different query and a
 * different cost model.
 *
 * Kept out of `host-files.ts` on purpose. That module is the audited containment
 * core; this one walks *inside* an already-resolved, already-contained directory
 * and never resolves a path of its own. Its one security-relevant rule is that it
 * does not follow symlinks — see the walk below.
 */

/**
 * Directories a source tree keeps that nobody types `@` looking for, and that are
 * usually most of the entries on disk. Skipping them is what makes the walk cheap
 * enough to run per keystroke; the operator can replace the list via
 * `hostFiles.ignore`.
 */
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
]

export type FoundFile = {
  /** Absolute path, for a follow-up read. */
  path: string
  /** Path relative to the searched directory — what a picker shows and inserts. */
  relative: string
}

export type SearchResult = {
  matches: FoundFile[]
  /** More matched (or more of the tree existed) than was returned. */
  truncated: boolean
}

export type SearchOptions = {
  /** Fuzzy needle. Empty returns the shallowest files, which is what a bare `@` wants. */
  query?: string
  /** Max results returned. */
  limit?: number
  /** Directory names not to descend into. Defaults to {@link DEFAULT_IGNORED_DIRS}. */
  ignore?: readonly string[]
  /** Hard bound on entries examined, so a walk can't be turned into a DoS by
   * pointing it at a huge tree. Reaching it truncates rather than erroring. */
  maxScanned?: number
}

/**
 * Breadth-first so shallow files rank first before scoring even runs — for a bare
 * `@` that ordering *is* the ranking, and for a query it breaks ties the way a
 * person expects (`src/index.ts` over `src/a/b/c/index.ts`).
 *
 * Symlinks are skipped outright, as files and as directories. As directories it is
 * the difference between a bounded walk and an unbounded one (a cycle, or a link
 * to `/`); as files it keeps this function's output within the tree it was handed,
 * so nothing it offers can be a path that `resolveExisting` would later refuse.
 * A tree that genuinely lives behind symlinks is not autocompletable — an accepted
 * cost for not having to re-derive containment here.
 */
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
      // Unreadable directory — skip it rather than failing the whole search.
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
        if (!ignore.has(entry.name)) queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (kind !== 'file') continue
      const path = join(dir, entry.name)
      const rel = relative(base, path)
      const score = scoreMatch(rel, entry.name, needle)
      if (score !== null) found.push({ file: { path, relative: rel }, score, depth })
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

/**
 * Subsequence matching, like every `@`-picker worth using: `seslist` finds
 * `SessionListView.swift`. Returns null for no match.
 *
 * Scored so the two things people actually mean win — a hit in the filename beats
 * one buried in the directory path, and characters typed consecutively beat the
 * same characters scattered — rather than trying to be a ranking engine.
 */
function scoreMatch(relativePath: string, name: string, needle: string): number | null {
  if (needle === '') return 0
  const inName = subsequenceScore(name.toLowerCase(), needle)
  if (inName !== null) return inName + 1000
  return subsequenceScore(relativePath.toLowerCase(), needle)
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let score = 0
  let from = 0
  let previous = -2
  for (const char of needle) {
    const at = haystack.indexOf(char, from)
    if (at === -1) return null
    if (at === previous + 1) score += 8
    if (at === 0) score += 4
    from = at + 1
    previous = at
  }
  // Shorter haystacks matched the same needle more tightly.
  return score - haystack.length / 100
}
