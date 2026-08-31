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

export const flattenHostTree = (root: string, dirs: ReadonlyMap<string, HostDirState>, expanded: ReadonlySet<string>): HostTreeRow[] => {
  const rows: HostTreeRow[] = []
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

export const ancestorsWithin = (root: string, path: string): string[] => {
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
