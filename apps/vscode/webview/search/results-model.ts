import type { HostSearchFile, HostSearchLine, HostSearchMatch } from '@workerdeck/protocol'
import { fileMatchCount, hostSearchTree, matchKey, sortedSearchFiles, type HostSearchNode } from '@workerdeck/react'

export type CollapseMode = 'auto' | 'alwaysCollapse' | 'alwaysExpand'

export type FolderRow = {
  kind: 'folder'
  key: string
  depth: number
  path: string
  name: string
  matches: number
  collapsed: boolean
  files: HostSearchFile[]
}
export type FileRow = { kind: 'file'; key: string; depth: number; file: HostSearchFile; matches: number; collapsed: boolean }
export type MatchRow = { kind: 'match'; key: string; depth: number; file: HostSearchFile; line: HostSearchLine; match: HostSearchMatch }
export type ResultRow = FolderRow | FileRow | MatchRow

export type Collapse = { all: boolean; mode: CollapseMode; overrides: ReadonlyMap<string, boolean> }

const AUTO_COLLAPSE_OVER = 10

export function fileKey(path: string): string {
  return `f:${path}`
}

export function folderKey(path: string): string {
  return `d:${path}`
}

export function matchRowKey(path: string, match: HostSearchMatch): string {
  return `m:${path}:${matchKey(match)}`
}

function collapsedFile(collapse: Collapse, key: string, matches: number): boolean {
  const override = collapse.overrides.get(key)
  if (override !== undefined) {
    return override
  }
  if (collapse.all || collapse.mode === 'alwaysCollapse') {
    return true
  }
  return collapse.mode === 'auto' && matches > AUTO_COLLAPSE_OVER
}

function collapsedFolder(collapse: Collapse, key: string): boolean {
  return collapse.overrides.get(key) ?? collapse.all
}

export function resultRows(files: readonly HostSearchFile[], tree: boolean, collapse: Collapse): ResultRow[] {
  const rows: ResultRow[] = []
  const pushFile = (file: HostSearchFile, depth: number) => {
    const key = fileKey(file.path)
    const matches = fileMatchCount(file)
    const collapsed = collapsedFile(collapse, key, matches)
    rows.push({ kind: 'file', key, depth, file, matches, collapsed })
    if (collapsed) {
      return
    }
    for (const line of file.lines) {
      for (const match of line.matches) {
        rows.push({ kind: 'match', key: matchRowKey(file.path, match), depth: depth + 1, file, line, match })
      }
    }
  }
  if (!tree) {
    for (const file of sortedSearchFiles(files)) {
      pushFile(file, 0)
    }
    return rows
  }
  const walk = (nodes: HostSearchNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        pushFile(node.file, depth)
        continue
      }
      const key = folderKey(node.path)
      const collapsed = collapsedFolder(collapse, key)
      rows.push({ kind: 'folder', key, depth, path: node.path, name: node.name, matches: node.matches, collapsed, files: filesUnder(node) })
      if (!collapsed) {
        walk(node.children, depth + 1)
      }
    }
  }
  walk(hostSearchTree(files), 0)
  return rows
}

function filesUnder(node: HostSearchNode): HostSearchFile[] {
  if (node.kind === 'file') {
    return [node.file]
  }
  return node.children.flatMap(filesUnder)
}

export function parentKey(rows: readonly ResultRow[], index: number): string | undefined {
  const row = rows[index]
  if (!row || row.depth === 0) {
    return undefined
  }
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i]!.depth < row.depth) {
      return rows[i]!.key
    }
  }
  return undefined
}

export function dirOf(relative: string): string {
  const slash = relative.lastIndexOf('/')
  return slash === -1 ? '' : relative.slice(0, slash)
}

export function nameOf(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1)
}

export function resultCountText(matches: number, files: number): string {
  const results = matches === 1 ? '1 result' : `${matches} results`
  const across = files === 1 ? '1 file' : `${files} files`
  return `${results} in ${across}`
}

export function replacedText(matches: number, files: number, replace: string): string {
  const occurrences = matches === 1 ? '1 occurrence' : `${matches} occurrences`
  const across = files === 1 ? '1 file' : `${files} files`
  return replace ? `Replaced ${occurrences} across ${across} with '${replace}'.` : `Replaced ${occurrences} across ${across}.`
}

export function noResultsText(includes: string, excludes: string): string {
  if (includes && excludes) {
    return `No results found in '${includes}' excluding '${excludes}' - `
  }
  if (includes) {
    return `No results found in '${includes}' - `
  }
  if (excludes) {
    return `No results found excluding '${excludes}' - `
  }
  return 'No results found. Review your settings for configured exclusions and check your gitignore files - '
}
