import { describe, expect, it } from 'vitest'
import { errorMessage, resolvePosix } from '@workerdeck/protocol'

describe('errorMessage', () => {
  it('reads an Error message', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom')
  })

  it('uses the fallback for anything that is not an Error', () => {
    expect(errorMessage('nope', 'fallback')).toBe('fallback')
    expect(errorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('stringifies without a fallback', () => {
    expect(errorMessage('nope')).toBe('nope')
    expect(errorMessage(42)).toBe('42')
  })
})

describe('resolvePosix', () => {
  it('normalizes an absolute path and ignores the cwd', () => {
    expect(resolvePosix('/a/./b//c/../d', '/elsewhere')).toBe('/a/b/d')
  })

  it('resolves a relative path against the cwd', () => {
    expect(resolvePosix('./src/../docs/A.md', '/repo/')).toBe('/repo/docs/A.md')
    expect(resolvePosix('x', '/repo')).toBe('/repo/x')
  })

  it('has no answer for a relative path without a cwd', () => {
    expect(resolvePosix('x', undefined)).toBeUndefined()
    expect(resolvePosix('x', '')).toBeUndefined()
  })

  it('never climbs above the root', () => {
    expect(resolvePosix('../../x', '/a')).toBe('/x')
  })
})
