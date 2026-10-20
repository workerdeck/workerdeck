import type { FileEntryKind, WireFileEntry } from '../../src/bridge-protocol.ts'

export type DirState = { entries?: WireFileEntry[]; error?: string }

export type Edit = { mode: 'rename'; uri: string } | { mode: 'create'; parent: string; entry: FileEntryKind }

export type EntryRow = { kind: 'entry'; entry: WireFileEntry; level: number; expanded: boolean; parent: string; ancestors: string[] }

export type CreateRow = { kind: 'create'; entry: FileEntryKind; level: number; parent: string; ancestors: string[] }

export type Row = EntryRow | CreateRow

export const ROW_HEIGHT = 22
export const INDENT = 8

export function flatten(root: string, dirs: ReadonlyMap<string, DirState>, expanded: ReadonlySet<string>, edit: Edit | undefined): Row[] {
  const rows: Row[] = []
  const walk = (dir: string, level: number, ancestors: string[]) => {
    if (edit?.mode === 'create' && edit.parent === dir) {
      rows.push({ kind: 'create', entry: edit.entry, level, parent: dir, ancestors })
    }
    for (const entry of dirs.get(dir)?.entries ?? []) {
      const open = entry.kind === 'folder' && expanded.has(entry.uri)
      rows.push({ kind: 'entry', entry, level, expanded: open, parent: dir, ancestors })
      if (open) {
        walk(entry.uri, level + 1, [...ancestors, entry.uri])
      }
    }
  }
  walk(root, 1, [])
  return rows
}

export function rowKey(row: Row): string {
  return row.kind === 'entry' ? row.entry.uri : `create:${row.parent}`
}

export function parentOf(uri: string): string {
  return uri.replace(/\/[^/]*$/, '')
}

export function nameOf(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))
}

// The folder a drop, paste or "new file" lands in: a folder row itself, a file row's parent.
export function folderFor(row: Row | undefined, root: string): string {
  if (!row) {
    return root
  }
  if (row.kind === 'create') {
    return row.parent
  }
  return row.entry.kind === 'folder' ? row.entry.uri : row.parent
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
  const keys = rows.filter((r): r is EntryRow => r.kind === 'entry').map((r) => r.entry.uri)
  const a = keys.indexOf(from)
  const b = keys.indexOf(to)
  if (a < 0 || b < 0) {
    return [to]
  }
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1)
}
