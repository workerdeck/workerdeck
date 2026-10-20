import type { FileEntryKind, WireFileEntry } from '../../src/bridge-protocol.ts'

export type DirState = { entries?: WireFileEntry[]; error?: string }

export type Edit = { mode: 'rename'; uri: string } | { mode: 'create'; parent: string; entry: FileEntryKind }

export type EntryRow = {
  kind: 'entry'
  entry: WireFileEntry
  chain: WireFileEntry[]
  level: number
  expanded: boolean
  parent: string
  ancestors: string[]
}

export type CreateRow = { kind: 'create'; entry: FileEntryKind; level: number; parent: string; ancestors: string[] }

export type Row = EntryRow | CreateRow

export const ROW_HEIGHT = 22
export const INDENT = 8

export function flatten(
  root: string,
  dirs: ReadonlyMap<string, DirState>,
  expanded: ReadonlySet<string>,
  edit: Edit | undefined,
  compact: boolean,
): Row[] {
  const rows: Row[] = []
  const walk = (dir: string, level: number, ancestors: string[]) => {
    if (edit?.mode === 'create' && edit.parent === dir) {
      rows.push({ kind: 'create', entry: edit.entry, level, parent: dir, ancestors })
    }
    for (const head of dirs.get(dir)?.entries ?? []) {
      const chain = compact ? compressed(head, dirs, edit) : [head]
      const entry = chain.at(-1)!
      const open = entry.kind === 'folder' && chain.every((e) => expanded.has(e.uri))
      rows.push({ kind: 'entry', entry, chain, level, expanded: open, parent: dir, ancestors })
      if (open) {
        walk(entry.uri, level + 1, [...ancestors, entry.uri])
      }
    }
  }
  walk(root, 1, [])
  return rows
}

function compressed(head: WireFileEntry, dirs: ReadonlyMap<string, DirState>, edit: Edit | undefined): WireFileEntry[] {
  const chain = [head]
  let last = head
  while (!(edit?.mode === 'create' && edit.parent === last.uri)) {
    const only = soleFolder(dirs.get(last.uri)?.entries)
    if (!only || last.kind !== 'folder') {
      break
    }
    chain.push(only)
    last = only
  }
  return chain
}

export function soleFolder(entries: readonly WireFileEntry[] | undefined): WireFileEntry | undefined {
  return entries?.length === 1 && entries[0]!.kind === 'folder' ? entries[0] : undefined
}

export function chainParent(row: EntryRow, index: number): string {
  return index > 0 ? row.chain[index - 1]!.uri : row.parent
}

export function rowKey(row: Row): string {
  return row.kind === 'entry' ? row.chain[0]!.uri : `create:${row.parent}`
}

export function parentOf(uri: string): string {
  return uri.replace(/\/[^/]*$/, '')
}

export function nameOf(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))
}

// The folder a drop, paste or "new file" lands in: a folder row itself, a file row's parent.
export function folderFor(row: Row | undefined, root: string, active?: WireFileEntry): string {
  if (!row) {
    return root
  }
  if (row.kind === 'create') {
    return row.parent
  }
  const entry = active ?? row.entry
  return entry.kind === 'folder' ? entry.uri : row.parent
}

function clean(value: string): string {
  return value.toLowerCase().replace(/\s/g, '/')
}

// VS Code's getIconClasses: whitespace becomes '/', everything lower-cased, then name, every dot-suffix and the language.
export function iconClasses(entry: { name: string; kind: FileEntryKind; lang?: string }, parentName: string): string[] {
  const name = clean(entry.name)
  const classes = [entry.kind === 'folder' ? 'folder-icon' : 'file-icon', `${clean(parentName)}-name-dir-icon`]
  if (entry.kind === 'folder') {
    classes.push(`${name}-name-folder-icon`)
    return classes
  }
  classes.push(`${name}-name-file-icon`, 'name-file-icon')
  if (name.length <= 255) {
    const segments = name.split('.')
    for (let i = 1; i < segments.length; i++) {
      classes.push(`${segments.slice(i).join('.')}-ext-file-icon`)
    }
  }
  classes.push('ext-file-icon')
  if (entry.lang) {
    classes.push(`${clean(entry.lang)}-lang-file-icon`)
  }
  return classes
}

// The Explorer's rename/create validation, message for message.
export function validateName(
  value: string,
  siblings: readonly string[],
  original?: string,
): { text: string; severity: 'error' | 'warning' } | undefined {
  if (!value || !value.trim()) {
    return { text: 'A file or folder name must be provided.', severity: 'error' }
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    return { text: 'A file or folder name cannot start with a slash.', severity: 'error' }
  }
  const parts = value.split(/[/\\]/)
  if (parts.some((part) => part === '.' || part === '..')) {
    return { text: `The name **${value}** is not valid as a file or folder name. Please choose a different name.`, severity: 'error' }
  }
  const first = parts[0]!.toLowerCase()
  const caseOnlyRename = first === original?.toLowerCase()
  if (!caseOnlyRename && siblings.some((name) => name.toLowerCase() === first)) {
    return { text: `A file or folder **${parts[0]}** already exists at this location. Please choose a different name.`, severity: 'error' }
  }
  if (/^\s|\s$/.test(value)) {
    return { text: 'Leading or trailing whitespace detected in file or folder name.', severity: 'warning' }
  }
  return undefined
}

export function rangeBetween(rows: readonly Row[], from: string, to: string): string[] {
  const keys = rows.filter((r): r is EntryRow => r.kind === 'entry').map(rowKey)
  const a = keys.indexOf(from)
  const b = keys.indexOf(to)
  if (a < 0 || b < 0) {
    return [to]
  }
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export type TreeShape = { parent: number[]; end: number[] }

export type StickyRow = { index: number; top: number }

const STICKY_VIEW_RATIO = 0.4

export function treeShape(rows: readonly Row[]): TreeShape {
  const parent = rows.map(() => -1)
  const end = rows.map((_, i) => i)
  const open: number[] = []
  rows.forEach((row, i) => {
    while (open.length > 0 && rows[open.at(-1)!]!.level >= row.level) {
      open.pop()
    }
    parent[i] = open.at(-1) ?? -1
    for (const ancestor of open) {
      end[ancestor] = i
    }
    open.push(i)
  })
  return { parent, end }
}

// The workbench's StickyScrollController: ancestors of the top row pin, each pushed up once its last descendant scrolls past.
export function stickyRows(rows: readonly Row[], shape: TreeShape, scrollTop: number, viewport: number, max: number): StickyRow[] {
  const stuck: StickyRow[] = []
  let height = 0
  let first = Math.floor(scrollTop / ROW_HEIGHT)
  let previous: number | undefined
  while (max > 0 && first < rows.length) {
    const node = ancestorUnder(shape.parent, first, previous)
    if (node === undefined) {
      break
    }
    if (node === first) {
      const row = rows[node]
      if (row?.kind !== 'entry' || !row.expanded || node * ROW_HEIGHT - scrollTop === height) {
        break
      }
    }
    const bottom = (shape.end[node]! + 1) * ROW_HEIGHT - scrollTop
    const top = height + ROW_HEIGHT > bottom && height <= bottom ? bottom - ROW_HEIGHT : height
    stuck.push({ index: node, top })
    height += ROW_HEIGHT
    if (stuck.length > max) {
      break
    }
    first = Math.floor((scrollTop + top + ROW_HEIGHT) / ROW_HEIGHT)
    previous = node
  }
  const kept = stuck.findIndex((row, i) => i >= max || row.top + ROW_HEIGHT > STICKY_VIEW_RATIO * viewport)
  return kept < 0 ? stuck : stuck.slice(0, kept)
}

function ancestorUnder(parent: readonly number[], index: number, previous: number | undefined): number | undefined {
  let current = index
  while (parent[current]! >= 0) {
    if (parent[current] === previous) {
      return current
    }
    current = parent[current]!
  }
  return previous === undefined ? current : undefined
}
