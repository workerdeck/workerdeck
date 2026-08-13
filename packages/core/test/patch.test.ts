import { describe, expect, it } from 'vitest'
import { filePatchFromToolResult, parseUnifiedDiff } from '../src/patch.ts'

/**
 * These two functions are the only reason a client can print a line number, so
 * they are tested for the properties a renderer depends on: the engine's own
 * numbers survive intact, the file contents that must not reach the wire are
 * dropped, and anything that is not really a patch answers `undefined` rather
 * than a plausible-looking one.
 */

describe('filePatchFromToolResult', () => {
  const hunk = {
    oldStart: 6,
    oldLines: 5,
    newStart: 6,
    newLines: 8,
    lines: ['   "printWidth": 120,', '+    "**/*.md",', '   "**/build/**",'],
  }

  it('keeps the engine\'s hunks and the path', () => {
    const patch = filePatchFromToolResult({
      filePath: '/repo/.prettierrc',
      oldString: 'a',
      newString: 'b',
      originalFile: 'the whole file',
      structuredPatch: [hunk],
      userModified: false,
      replaceAll: false,
    })
    expect(patch).toEqual({ path: '/repo/.prettierrc', kind: 'update', hunks: [hunk] })
  })

  it('drops originalFile — the wire must never carry the file', () => {
    const patch = filePatchFromToolResult({
      filePath: '/repo/a.ts',
      originalFile: 'x'.repeat(100_000),
      structuredPatch: [hunk],
    })
    expect(JSON.stringify(patch)).not.toContain('xxxx')
  })

  it('reads a null originalFile as a creation', () => {
    const patch = filePatchFromToolResult({
      filePath: '/repo/new.ts',
      originalFile: null,
      structuredPatch: [hunk],
    })
    expect(patch?.kind).toBe('create')
  })

  it('takes Write\'s own create/update verdict', () => {
    const patch = filePatchFromToolResult({
      type: 'create',
      filePath: '/repo/new.ts',
      content: 'hi',
      originalFile: null,
      structuredPatch: [hunk],
    })
    expect(patch?.kind).toBe('create')
  })

  it('answers undefined for output that is not a file edit', () => {
    expect(filePatchFromToolResult(undefined)).toBeUndefined()
    expect(filePatchFromToolResult({ stdout: 'ok' })).toBeUndefined()
    // A malformed hunk is not a hunk: better no diff than one whose line
    // numbers are NaN.
    expect(filePatchFromToolResult({ structuredPatch: [{ lines: ['+x'] }] })).toBeUndefined()
  })

  it('truncates a huge patch and says so', () => {
    const big = { ...hunk, lines: Array.from({ length: 300 }, (_, i) => `+line ${i}`) }
    const patch = filePatchFromToolResult({ structuredPatch: [big, big, big] })
    expect(patch?.hunks).toHaveLength(1)
    expect(patch?.truncated).toBe(true)
  })

  it('keeps a single oversized hunk rather than dropping the whole diff', () => {
    const huge = { ...hunk, lines: Array.from({ length: 900 }, (_, i) => `+line ${i}`) }
    const patch = filePatchFromToolResult({ structuredPatch: [huge] })
    expect(patch?.hunks).toHaveLength(1)
  })
})

describe('parseUnifiedDiff', () => {
  it('reads hunk headers as the line numbers they are', () => {
    const patch = parseUnifiedDiff(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -98,3 +104,3 @@', ' const a = 1', '-const b = 2', '+const b = 3'].join('\n'),
      '/repo/x.ts',
    )
    expect(patch).toEqual({
      path: '/repo/x.ts',
      hunks: [
        {
          oldStart: 98,
          oldLines: 3,
          newStart: 104,
          newLines: 3,
          lines: [' const a = 1', '-const b = 2', '+const b = 3'],
        },
      ],
    })
  })

  it('reads an absent count as one line', () => {
    const patch = parseUnifiedDiff('@@ -4 +4 @@\n-a\n+b')
    expect(patch?.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 })
  })

  it('keeps a blank line as context', () => {
    // A context line that was only a space often arrives stripped. Dropping it
    // would shift every line number below it in the hunk.
    const patch = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n+b')
    expect(patch?.hunks[0]?.lines).toEqual([' a', ' ', '+b'])
  })

  it('answers undefined when there are no hunks', () => {
    expect(parseUnifiedDiff('Binary files differ')).toBeUndefined()
    expect(parseUnifiedDiff('')).toBeUndefined()
  })

  it('reads every hunk of a multi-hunk diff', () => {
    const patch = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +50,1 @@\n-c\n+d')
    expect(patch?.hunks.map((h) => h.newStart)).toEqual([1, 50])
  })
})
