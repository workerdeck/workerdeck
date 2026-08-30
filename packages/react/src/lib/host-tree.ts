import type { HostDirEntry } from '@workerdeck/protocol'

/**
 * One directory as the tree knows it: what `/fs/list` answered, plus whether the
 * server held entries back.
 *
 * A directory that has never been asked for is simply absent from the map — which
 * is not the same as an empty directory, and the difference is what tells the
 * renderer to show a spinner rather than "nothing here".
 */
export type HostDirState = {
  entries: HostDirEntry[]
  /** The directory held more entries than the server will return. */
  truncated?: boolean
}

/** One rendered row of the tree — a flat list is what a scroll container wants,
 * and indentation is a number, not a nesting of DOM. */
export type HostTreeRow = {
  entry: HostDirEntry
  /** 0 for the root's own children. */
  depth: number
  /** Directories only: whether this row's children are showing. */
  expanded?: boolean
  /** Set on an expanded directory whose listing hasn't arrived yet. */
  loading?: boolean
  /** Set on an expanded directory the server truncated. */
  truncated?: boolean
}

/**
 * Flatten the loaded directories into the rows the tree shows.
 *
 * Pure, so the interesting part of a file tree — which nodes are visible at what
 * depth once a few directories are expanded and one of them is still loading —
 * is testable without a DOM or a gateway.
 *
 * Only *expanded* directories contribute children, and only if their listing has
 * arrived. An expanded-but-unlisted directory yields its own row with
 * `loading: true` and no children: expansion is a request the user already made,
 * so the row must say the answer is coming rather than look like an empty folder.
 */
export const flattenHostTree = (root: string, dirs: ReadonlyMap<string, HostDirState>, expanded: ReadonlySet<string>): HostTreeRow[] => {
  const rows: HostTreeRow[] = []
  // Iterative rather than recursive: a deep tree is a user's checkout, not a
  // bounded structure, and blowing the stack on someone's monorepo would be a
  // silly way to fail.
  const walk = (dir: string, depth: number) => {
    const state = dirs.get(dir)
    if (!state) {
      return
    }
    for (const entry of state.entries) {
      if (entry.type !== 'dir') {
        rows.push({ entry, depth })
        continue
      }
      const isExpanded = expanded.has(entry.path)
      const childState = dirs.get(entry.path)
      rows.push({
        entry,
        depth,
        expanded: isExpanded,
        loading: isExpanded && !childState,
        truncated: isExpanded ? childState?.truncated : undefined,
      })
      if (isExpanded && childState) {
        walk(entry.path, depth + 1)
      }
    }
  }
  walk(root, 0)
  return rows
}

/**
 * Every ancestor of `path` below `root`, outermost first — the directories that
 * must be expanded for `path` to be on screen.
 *
 * Returns `[]` when `path` is not under `root` rather than guessing: revealing a
 * file the tree cannot contain is a no-op, not an error worth raising, and the
 * caller has no better answer either.
 *
 * The prefix test is on a **path boundary** (`root` + `/`), so `/src/app` is not
 * treated as living under `/src/a`.
 */
export const ancestorsWithin = (root: string, path: string): string[] => {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  if (path === base || !path.startsWith(`${base}/`)) {
    return []
  }
  const rest = path.slice(base.length + 1).split('/')
  // The last segment is the file itself, which is not a directory to expand.
  const out: string[] = []
  let current = base
  for (const segment of rest.slice(0, -1)) {
    current = `${current}/${segment}`
    out.push(current)
  }
  return out
}
