import type { HostDirEntry } from '@workerdeck/protocol'

export type HostDirState = {
  entries: HostDirEntry[]
  truncated?: boolean
}

export type HostTreeRow = {
  entry: HostDirEntry
  depth: number
  expanded?: boolean
  loading?: boolean
  truncated?: boolean
}

export function flattenHostTree(root: string, dirs: ReadonlyMap<string, HostDirState>, expanded: ReadonlySet<string>): HostTreeRow[] {
  const rows: HostTreeRow[] = []
  const rootState = dirs.get(root)
  if (!rootState) {
    return rows
  }
  // An explicit stack rather than recursion. Depth is bounded by how many directories the user has
  // expanded, not by tree size, so this is a small risk — but it is the user's clicks that set the
  // bound, and an expanded chain deep enough to exhaust the call stack should still just render.
  const stack: { entries: readonly HostDirEntry[]; index: number; depth: number }[] = [{ entries: rootState.entries, index: 0, depth: 0 }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    const entry = frame.entries[frame.index]
    if (entry === undefined) {
      stack.pop()
      continue
    }
    frame.index += 1
    const depth = frame.depth
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
      stack.push({ entries: childState.entries, index: 0, depth: depth + 1 })
    }
  }
  return rows
}

export function ancestorsWithin(root: string, path: string): string[] {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  if (path === base || !path.startsWith(`${base}/`)) {
    return []
  }
  const rest = path.slice(base.length + 1).split('/')
  const out: string[] = []
  let current = base
  for (const segment of rest.slice(0, -1)) {
    current = `${current}/${segment}`
    out.push(current)
  }
  return out
}
