import { describe, expect, it } from 'vitest'
import { matchPath } from '../src/lib/path-match.ts'

describe('matchPath', () => {
  it('finds an absolute path inside prose, with its line', () => {
    expect(matchPath('see /Users/me/proj/src/a.ts:12 for the call')).toEqual({ path: '/Users/me/proj/src/a.ts', line: 12, length: 26 })
  })

  it('starts at a token boundary, so an @mention keeps its whole path', () => {
    expect(matchPath('@_docs/BACKLOG.md')?.path).toBe('_docs/BACKLOG.md')
  })

  it('refuses a relative path with no filename extension', () => {
    expect(matchPath('either and/or both')).toBeUndefined()
    expect(matchPath('./scripts/build')?.path).toBe('./scripts/build')
  })

  it('strips trailing punctuation and refuses a bare directory', () => {
    expect(matchPath('(packages/ui/src/index.ts).')?.path).toBe('packages/ui/src/index.ts')
    expect(matchPath('packages/ui/')).toBeUndefined()
  })

  it('accepts a bare filename only inside code', () => {
    expect(matchPath('runner.ts:40')).toBeUndefined()
    expect(matchPath('runner.ts:40', true)).toEqual({ path: 'runner.ts', line: 40, length: 12 })
  })

  it('reports how much of the text the path covered', () => {
    const hit = matchPath('a/b.ts')
    expect(hit?.length).toBe(6)
  })
})
