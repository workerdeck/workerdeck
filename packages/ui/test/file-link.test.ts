import { describe, expect, it } from 'vitest'
import { parseFileLink } from '../src/lib/file-link.ts'

const cwd = '/Users/me/project'

describe('parseFileLink', () => {
  it('resolves the relative forms an agent actually writes', () => {
    expect(parseFileLink('./SPEC.md', cwd)).toEqual({ path: '/Users/me/project/SPEC.md' })
    expect(parseFileLink('docs/AUTH.md', cwd)).toEqual({ path: '/Users/me/project/docs/AUTH.md' })
    expect(parseFileLink('../features/README.md', cwd)).toEqual({ path: '/Users/me/features/README.md' })
  })

  it('keeps an absolute path, with or without a cwd', () => {
    expect(parseFileLink('/etc/hosts', cwd)).toEqual({ path: '/etc/hosts' })
    expect(parseFileLink('/etc/hosts', undefined)).toEqual({ path: '/etc/hosts' })
  })

  it('reads a line from either spelling, and drops a plain anchor', () => {
    expect(parseFileLink('src/main.ts:42', cwd)).toEqual({ path: '/Users/me/project/src/main.ts', line: 42 })
    expect(parseFileLink('src/main.ts:42:9', cwd)).toEqual({ path: '/Users/me/project/src/main.ts', line: 42 })
    expect(parseFileLink('docs/AUTH.md#L12', cwd)).toEqual({ path: '/Users/me/project/docs/AUTH.md', line: 12 })
    expect(parseFileLink('docs/AUTH.md#agent-identity', cwd)).toEqual({ path: '/Users/me/project/docs/AUTH.md' })
  })

  it('decodes a file URL', () => {
    expect(parseFileLink('file:///tmp/my%20notes.txt', undefined)).toEqual({ path: '/tmp/my notes.txt' })
  })

  it('leaves every non-file target alone', () => {
    expect(parseFileLink('https://example.com/docs.md', cwd)).toBeUndefined()
    expect(parseFileLink('mailto:me@example.com', cwd)).toBeUndefined()
    expect(parseFileLink('//example.com/x', cwd)).toBeUndefined()
    expect(parseFileLink('#section', cwd)).toBeUndefined()
    expect(parseFileLink('', cwd)).toBeUndefined()
    expect(parseFileLink(undefined, cwd)).toBeUndefined()
  })

  it('cannot resolve a relative path before the cwd is known', () => {
    expect(parseFileLink('./SPEC.md', undefined)).toBeUndefined()
  })
})
