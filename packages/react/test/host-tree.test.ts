import { describe, expect, it } from 'vitest'
import type { HostDirEntry } from '@workerdeck/protocol'
import { ancestorsWithin, flattenHostTree, type HostDirState } from '../src/lib/host-tree.ts'

const dir = (path: string): HostDirEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'dir',
})
const file = (path: string): HostDirEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  bytes: 10,
})

const tree = (entries: Record<string, HostDirEntry[]>) =>
  new Map<string, HostDirState>(Object.entries(entries).map(([k, v]) => [k, { entries: v }]))

const shape = (rows: ReturnType<typeof flattenHostTree>) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.entry.name}${r.entry.type === 'dir' ? '/' : ''}`)

describe('flattenHostTree', () => {
  const dirs = tree({
    '/p': [dir('/p/src'), dir('/p/docs'), file('/p/README.md')],
    '/p/src': [dir('/p/src/lib'), file('/p/src/main.ts')],
    '/p/src/lib': [file('/p/src/lib/util.ts')],
    '/p/docs': [file('/p/docs/guide.md')],
  })

  it('shows only the root listing when nothing is expanded', () => {
    expect(shape(flattenHostTree('/p', dirs, new Set()))).toEqual(['src/', 'docs/', 'README.md'])
  })

  it('splices an expanded directory’s children in at the next depth', () => {
    expect(shape(flattenHostTree('/p', dirs, new Set(['/p/src'])))).toEqual([
      'src/',
      '  lib/',
      '  main.ts',
      'docs/',
      'README.md',
    ])
  })

  it('nests several levels in tree order, not listing order', () => {
    expect(shape(flattenHostTree('/p', dirs, new Set(['/p/src', '/p/src/lib', '/p/docs'])))).toEqual([
      'src/',
      '  lib/',
      '    util.ts',
      '  main.ts',
      'docs/',
      '  guide.md',
      'README.md',
    ])
  })

  it('marks an expanded directory whose listing has not arrived as loading', () => {
    const partial = tree({ '/p': [dir('/p/src')] })
    const [row] = flattenHostTree('/p', partial, new Set(['/p/src']))
    expect(row).toMatchObject({ expanded: true, loading: true })
  })

  it('does not report loading once the listing is in', () => {
    const [row] = flattenHostTree('/p', dirs, new Set(['/p/src']))
    expect(row).toMatchObject({ expanded: true, loading: false })
  })

  it('surfaces truncation only on the expanded directory it belongs to', () => {
    const truncated = new Map<string, HostDirState>([
      ['/p', { entries: [dir('/p/big')] }],
      ['/p/big', { entries: [file('/p/big/a.ts')], truncated: true }],
    ])
    expect(flattenHostTree('/p', truncated, new Set())[0]?.truncated).toBeUndefined()
    expect(flattenHostTree('/p', truncated, new Set(['/p/big']))[0]?.truncated).toBe(true)
  })

  it('is empty until the root listing arrives', () => {
    expect(flattenHostTree('/p', new Map(), new Set())).toEqual([])
  })

  it('ignores expansion state for directories that are not visible', () => {
    // /p/src/lib is expanded but its parent is not — it must not leak in.
    expect(shape(flattenHostTree('/p', dirs, new Set(['/p/src/lib'])))).toEqual([
      'src/',
      'docs/',
      'README.md',
    ])
  })
})

describe('ancestorsWithin', () => {
  it('lists the directories to expand, outermost first', () => {
    expect(ancestorsWithin('/p', '/p/src/lib/util.ts')).toEqual(['/p/src', '/p/src/lib'])
  })

  it('returns nothing for a file sitting directly in the root', () => {
    expect(ancestorsWithin('/p', '/p/README.md')).toEqual([])
  })

  it('returns nothing for a path outside the root', () => {
    expect(ancestorsWithin('/p', '/other/a.ts')).toEqual([])
    expect(ancestorsWithin('/p', '/p')).toEqual([])
  })

  it('respects the path boundary — /src/app is not under /src/a', () => {
    expect(ancestorsWithin('/src/a', '/src/app/main.ts')).toEqual([])
  })

  it('tolerates a trailing slash on the root', () => {
    expect(ancestorsWithin('/p/', '/p/src/lib/util.ts')).toEqual(['/p/src', '/p/src/lib'])
  })
})
