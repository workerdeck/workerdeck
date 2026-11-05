import { describe, expect, it } from 'vitest'
import { replacementFor, searchGlobs, type HostSearchFile, type HostSearchLine } from '@workerdeck/protocol'
import {
  EMPTY_HOST_SEARCH_QUERY,
  hostSearchCounts,
  hostSearchReducer,
  hostSearchRequest,
  hostSearchTree,
  initialHostSearchState,
  matchKey,
  matchPreview,
  sortedSearchFiles,
  type HostSearchFolder,
} from '../src/lib/host-search.ts'

function line(lineNo: number, text: string, columns: [number, number][]): HostSearchLine {
  return {
    line: lineNo,
    start: 0,
    text,
    matches: columns.map(([column, endColumn]) => ({
      line: lineNo,
      column,
      endLine: lineNo,
      endColumn,
      text: text.slice(column, endColumn),
    })),
  }
}

function file(relative: string, lines: HostSearchLine[]): HostSearchFile {
  return { type: 'file', path: `/root/${relative}`, relative, lines }
}

describe('searchGlobs', () => {
  it('expands VS Code include text the way its query builder does', () => {
    expect(searchGlobs('src')).toEqual(['**/src', '**/src/**'])
    expect(searchGlobs('*.ts, ./docs/')).toEqual(['**/*.ts', '**/*.ts/**', 'docs', 'docs/**'])
    expect(searchGlobs('**/*.{ts,tsx}')).toEqual(['**/*.{ts,tsx}', '**/*.{ts,tsx}/**'])
    expect(searchGlobs('  , ')).toEqual([])
  })

  it('anchors absolute paths inside the root and drops the rest', () => {
    expect(searchGlobs('/root/src/lib, /elsewhere/x, /root', '/root')).toEqual(['src/lib', 'src/lib/**'])
  })
})

describe('replacementFor', () => {
  it('replaces literally outside regex mode', () => {
    expect(replacementFor('foo', { query: 'foo', replace: '$1\\n' })).toBe('$1\\n')
  })

  it('expands groups, escapes and case operators in regex mode', () => {
    const options = { query: '(\\w+)-(\\w+)', isRegex: true }
    expect(replacementFor('alpha-beta', { ...options, replace: '$2_$1' })).toBe('beta_alpha')
    expect(replacementFor('alpha-beta', { ...options, replace: '\\u$1\\U$2\\E!$$' })).toBe('AlphaBETA!$')
    expect(replacementFor('alpha-beta', { ...options, replace: '$0\\t$&\\n' })).toBe('alpha-beta\talpha-beta\n')
  })

  it('preserves the case shape of what it replaces', () => {
    const options = { query: 'foo', replace: 'barBaz', preserveCase: true }
    expect(replacementFor('FOO', options)).toBe('BARBAZ')
    expect(replacementFor('foo', options)).toBe('barbaz')
    expect(replacementFor('Foo', options)).toBe('BarBaz')
    expect(replacementFor('fOO', options)).toBe('barBaz')
    expect(replacementFor('Foo-Bar', { query: 'foo-bar', replace: 'baz-qux', preserveCase: true })).toBe('Baz-Qux')
  })
})

describe('hostSearchRequest', () => {
  it('adds the settings excludes only while ignore files are on', () => {
    const query = { ...EMPTY_HOST_SEARCH_QUERY, query: 'x', includes: 'src', excludes: 'dist' }
    expect(hostSearchRequest('/root', query, ['**/.git'])).toMatchObject({
      includes: ['**/src', '**/src/**'],
      excludes: ['**/.git', '**/dist', '**/dist/**'],
    })
    expect(hostSearchRequest('/root', { ...query, useIgnoreFiles: false }, ['**/.git']).excludes).toEqual(['**/dist', '**/dist/**'])
  })
})

describe('hostSearchReducer', () => {
  const a = file('src/a.ts', [
    line(0, 'foo foo', [
      [0, 3],
      [4, 7],
    ]),
  ])
  const b = file('b.ts', [line(2, 'foo', [[0, 3]])])

  it('folds a run and ignores a stale one', () => {
    let state = hostSearchReducer(initialHostSearchState, { type: 'start', run: 2 })
    state = hostSearchReducer(state, { type: 'event', run: 1, event: b })
    state = hostSearchReducer(state, { type: 'event', run: 2, event: a })
    state = hostSearchReducer(state, { type: 'event', run: 2, event: { type: 'done', files: 1, matches: 2, truncated: true } })
    expect(state).toMatchObject({ status: 'done', truncated: true })
    expect(hostSearchCounts(state)).toEqual({ files: 1, matches: 2 })
  })

  it('dismisses a match, then the file once it is empty', () => {
    let state = { ...initialHostSearchState, files: [a, b] }
    state = hostSearchReducer(state, { type: 'dismiss-match', path: b.path, key: matchKey(b.lines[0]!.matches[0]!) })
    expect(state.files).toEqual([a])
    state = hostSearchReducer(state, { type: 'dismiss-match', path: a.path, key: matchKey(a.lines[0]!.matches[0]!) })
    expect(hostSearchCounts(state)).toEqual({ files: 1, matches: 1 })
  })
})

describe('result layout', () => {
  it('sorts folders before files at each level', () => {
    const files = ['z.ts', 'src/b.ts', 'src/lib/a.ts', 'a.ts'].map((path) => file(path, []))
    expect(sortedSearchFiles(files).map((f) => f.relative)).toEqual(['src/lib/a.ts', 'src/b.ts', 'a.ts', 'z.ts'])
  })

  it('builds a compacted tree with match counts', () => {
    const tree = hostSearchTree([
      file('packages/ui/src/a.ts', [line(0, 'x', [[0, 1]])]),
      file('packages/ui/src/b.ts', [
        line(0, 'xx', [
          [0, 1],
          [1, 2],
        ]),
      ]),
    ])
    const folder = tree[0] as HostSearchFolder
    expect([folder.name, folder.matches, folder.children.length]).toEqual(['packages/ui/src', 3, 2])
  })

  it('previews a match with trimmed indentation and a bounded lead', () => {
    const indented = line(0, '    const value = needle', [[18, 24]])
    expect(matchPreview(indented, indented.matches[0]!)).toMatchObject({ before: 'const value = ', match: 'needle', after: '' })
    const long = line(0, `${'x'.repeat(100)}needle tail`, [[100, 106]])
    const preview = matchPreview(long, long.matches[0]!)
    expect([preview.before.length, preview.match, preview.after, preview.trimmed]).toEqual([26, 'needle', ' tail', true])
  })
})
