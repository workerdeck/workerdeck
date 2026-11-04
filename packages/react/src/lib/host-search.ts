import {
  searchGlobs,
  type HostSearchEvent,
  type HostSearchFile,
  type HostSearchLine,
  type HostSearchMatch,
  type HostSearchRequest,
} from '@workerdeck/protocol'

export type HostSearchQuery = {
  query: string
  replace: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  preserveCase: boolean
  includes: string
  excludes: string
  useIgnoreFiles: boolean
}

export type HostSearchStatus = 'idle' | 'searching' | 'done' | 'error'

export type HostSearchState = {
  run: number
  status: HostSearchStatus
  files: HostSearchFile[]
  truncated: boolean
  error?: string
}

export type HostSearchAction =
  | { type: 'start'; run: number }
  | { type: 'event'; run: number; event: HostSearchEvent }
  | { type: 'fail'; run: number; message: string }
  | { type: 'clear' }
  | { type: 'dismiss-file'; path: string }
  | { type: 'dismiss-match'; path: string; key: string }
  | { type: 'dismiss-matches'; files: { path: string; keys: string[] }[] }

export type HostSearchFolder = {
  kind: 'folder'
  path: string
  name: string
  children: HostSearchNode[]
  matches: number
}

export type HostSearchFileNode = { kind: 'file'; file: HostSearchFile; matches: number }

export type HostSearchNode = HostSearchFolder | HostSearchFileNode

export type MatchPreview = { before: string; match: string; after: string; trimmed: boolean }

export const EMPTY_HOST_SEARCH_QUERY: HostSearchQuery = {
  query: '',
  replace: '',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  preserveCase: false,
  includes: '',
  excludes: '',
  useIgnoreFiles: true,
}

export const initialHostSearchState: HostSearchState = { run: 0, status: 'idle', files: [], truncated: false }

const PREVIEW_LEAD = 26

export function hostSearchReducer(state: HostSearchState, action: HostSearchAction): HostSearchState {
  switch (action.type) {
    case 'start': {
      return { run: action.run, status: 'searching', files: [], truncated: false }
    }
    case 'event': {
      if (action.run !== state.run) {
        return state
      }
      const { event } = action
      if (event.type === 'file') {
        return { ...state, files: [...state.files, event] }
      }
      if (event.type === 'done') {
        return { ...state, status: 'done', truncated: event.truncated }
      }
      return { ...state, status: 'error', error: event.message }
    }
    case 'fail': {
      return action.run === state.run ? { ...state, status: 'error', error: action.message } : state
    }
    case 'clear': {
      return initialHostSearchState
    }
    case 'dismiss-file': {
      return { ...state, files: state.files.filter((file) => file.path !== action.path) }
    }
    case 'dismiss-match': {
      return hostSearchReducer(state, { type: 'dismiss-matches', files: [{ path: action.path, keys: [action.key] }] })
    }
    case 'dismiss-matches': {
      const gone = new Map(action.files.map((file) => [file.path, new Set(file.keys)]))
      const files: HostSearchFile[] = []
      for (const file of state.files) {
        const keys = gone.get(file.path)
        if (!keys) {
          files.push(file)
          continue
        }
        const lines = withoutMatches(file.lines, keys)
        if (lines.length > 0) {
          files.push({ ...file, lines })
        }
      }
      return { ...state, files }
    }
  }
}

function withoutMatches(lines: HostSearchLine[], keys: ReadonlySet<string>): HostSearchLine[] {
  const kept: HostSearchLine[] = []
  for (const line of lines) {
    const matches = line.matches.filter((match) => !keys.has(matchKey(match)))
    if (matches.length > 0) {
      kept.push(matches.length === line.matches.length ? line : { ...line, matches })
    }
  }
  return kept
}

export function matchKey(match: HostSearchMatch): string {
  return `${match.line}:${match.column}:${match.endLine}:${match.endColumn}`
}

export function fileMatchCount(file: HostSearchFile): number {
  let count = 0
  for (const line of file.lines) {
    count += line.matches.length
  }
  return count
}

export function hostSearchCounts(state: HostSearchState): { files: number; matches: number } {
  let matches = 0
  for (const file of state.files) {
    matches += fileMatchCount(file)
  }
  return { files: state.files.length, matches }
}

export function hostSearchRequest(
  root: string,
  query: HostSearchQuery,
  settingsExcludes: readonly string[] = [],
  maxResults?: number,
): HostSearchRequest {
  const includes = searchGlobs(query.includes, root)
  const excludes = [...(query.useIgnoreFiles ? settingsExcludes : []), ...searchGlobs(query.excludes, root)]
  return {
    path: root,
    query: query.query,
    isRegex: query.isRegex,
    matchCase: query.matchCase,
    wholeWord: query.wholeWord,
    useIgnoreFiles: query.useIgnoreFiles,
    ...(includes.length > 0 ? { includes } : {}),
    ...(excludes.length > 0 ? { excludes } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
  }
}

export function compareSearchPaths(a: string, b: string): number {
  const left = a.split('/')
  const right = b.split('/')
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const leftIsDir = i < left.length - 1
    const rightIsDir = i < right.length - 1
    if (leftIsDir !== rightIsDir) {
      return leftIsDir ? -1 : 1
    }
    const order = left[i]!.localeCompare(right[i]!, undefined, { numeric: true, sensitivity: 'base' })
    if (order !== 0) {
      return order
    }
  }
  return left.length - right.length
}

export function sortedSearchFiles(files: readonly HostSearchFile[]): HostSearchFile[] {
  return [...files].sort((a, b) => compareSearchPaths(a.relative, b.relative))
}

export function hostSearchTree(files: readonly HostSearchFile[], compact = true): HostSearchNode[] {
  const root: HostSearchFolder = { kind: 'folder', path: '', name: '', children: [], matches: 0 }
  for (const file of sortedSearchFiles(files)) {
    const parts = file.relative.split('/')
    const count = fileMatchCount(file)
    let folder = root
    folder.matches += count
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = folder.children.find((child): child is HostSearchFolder => child.kind === 'folder' && child.path === path)
      if (!next) {
        next = { kind: 'folder', path, name: parts[i]!, children: [], matches: 0 }
        folder.children.push(next)
      }
      next.matches += count
      folder = next
    }
    folder.children.push({ kind: 'file', file, matches: count })
  }
  return compact ? root.children.map(compactFolder) : root.children
}

function compactFolder(node: HostSearchNode): HostSearchNode {
  if (node.kind === 'file') {
    return node
  }
  let folder = node
  while (folder.children.length === 1 && folder.children[0]!.kind === 'folder') {
    const only = folder.children[0] as HostSearchFolder
    folder = { ...only, name: `${folder.name}/${only.name}` }
  }
  return { ...folder, children: folder.children.map(compactFolder) }
}

export function matchPreview(line: HostSearchLine, match: HostSearchMatch): MatchPreview {
  const text = line.text
  const from = match.line === line.line ? Math.max(0, match.column - line.start) : 0
  const to = match.endLine === line.line ? Math.max(from, match.endColumn - line.start) : text.length
  const lead = Math.max(0, from - PREVIEW_LEAD)
  const before = text.slice(lead, from)
  return {
    before: before.trimStart(),
    match: text.slice(from, to),
    after: text.slice(to),
    trimmed: lead > 0 || line.start > 0,
  }
}
