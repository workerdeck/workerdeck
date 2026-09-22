import { describe, expect, it } from 'vitest'
import { countLines, headTail, splitLines, ttyText } from '../src/lib/tty-text.ts'

const LS_COLOR = '\x1b[1;34mdocs\x1b[0m  \x1b[1;32mrun.sh\x1b[0m  README.md\r\n\x1b[1;34mpackages\x1b[0m\r\n'

const NPM_PROGRESS =
  '\x1b[?25l[..........] \\ fetchMetadata: sill resolveWithNewModule\r' +
  '[######....] | fetchMetadata: sill resolveWithNewModule\x1b[K\r' +
  '[##########] - reify: timing\x1b[K\r\n' +
  '\x1b[?25h\x1b[Kadded 12 packages in 1s\r\n'

const OSC_TITLE = '\x1b]0;user@host: ~/project\x07$ echo hi\r\nhi\r\n'

const TPUT_PROMPT = '\x1b[1m\x1b[32m>\x1b[0m \x1b(B\x1b[mls\r\n'

const BOUNDS = { headLines: 3, headChars: 1000, tailLines: 3, tailChars: 1000 }

function numbered(n: number, width = 0): string {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`.padEnd(width, '.')).join('\n')
}

describe('ttyText', () => {
  it('strips SGR colour from a coloured ls and keeps its columns', () => {
    expect(ttyText(LS_COLOR)).toBe('docs  run.sh  README.md\npackages\n')
  })

  it('collapses a \\r progress bar to its final state', () => {
    expect(ttyText(NPM_PROGRESS)).toBe('[##########] - reify: timing\nadded 12 packages in 1s\n')
  })

  it('removes an OSC window title terminated by BEL or by ST', () => {
    expect(ttyText(OSC_TITLE)).toBe('$ echo hi\nhi\n')
    expect(ttyText('\x1b]2;title\x1b\\hi')).toBe('hi')
    expect(ttyText('\x9d0;eight-bit\x9chi')).toBe('hi')
  })

  it('strips charset designations and two-byte escapes around a tput-styled prompt', () => {
    expect(ttyText(TPUT_PROMPT)).toBe('> ls\n')
    expect(ttyText('\x1b7saved\x1b8\x1bM\x1bc')).toBe('saved')
  })

  it('strips eight-bit CSI, DCS strings and stray C0 controls', () => {
    expect(ttyText('\x9b31mred\x9b0m')).toBe('red')
    expect(ttyText('\x1bPq#0;2;0;0;0\x1b\\after')).toBe('after')
    expect(ttyText('a\x07b\x08c\x0cd\x7fe')).toBe('abcde')
  })

  it('normalises CRLF and keeps blank lines', () => {
    expect(ttyText('a\r\nb\r\n\r\nc')).toBe('a\nb\n\nc')
    expect(ttyText('\n\nlate start\n\n')).toBe('\n\nlate start\n\n')
  })

  it('reads a trailing \\r as an overwrite that has not happened yet', () => {
    expect(ttyText('50%\r')).toBe('50%')
    expect(ttyText('abc\r\r\n')).toBe('abc\n')
    expect(ttyText('\r\r')).toBe('')
  })

  it('trims trailing whitespace per line, tabs included', () => {
    expect(ttyText('foo   \nbar\t\n  indented  ')).toBe('foo\nbar\n  indented')
  })

  it('is idempotent on its own output', () => {
    const once = ttyText(NPM_PROGRESS + LS_COLOR + OSC_TITLE)
    expect(ttyText(once)).toBe(once)
  })
})

describe('splitLines and countLines', () => {
  it('agree, and do not count the newline that ends the text as a line', () => {
    for (const text of ['', '\n', 'a', 'a\n', 'a\n\n', 'a\nb', 'a\nb\n', '\n\nc']) {
      expect(countLines(text)).toBe(splitLines(text).length)
    }
    expect(splitLines('')).toEqual([])
    expect(splitLines('\n')).toEqual([''])
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(countLines('a\n\n')).toBe(2)
  })
})

describe('headTail', () => {
  it('returns the whole text as the head when it fits', () => {
    const text = numbered(5)
    expect(headTail(text, BOUNDS)).toEqual({ head: text, tail: '', omittedLines: 0, totalLines: 5, totalBytes: Buffer.byteLength(text) })
  })

  it('still fits exactly at the line bound and drops only the final newline', () => {
    const text = `${numbered(6)}\n`
    const result = headTail(text, BOUNDS)
    expect(result.head).toBe(numbered(6))
    expect(result.tail).toBe('')
    expect(result.omittedLines).toBe(0)
    expect(result.totalLines).toBe(6)
  })

  it('splits into head and tail one line over the line bound', () => {
    const result = headTail(numbered(7), BOUNDS)
    expect(result.head).toBe('line-1\nline-2\nline-3')
    expect(result.tail).toBe('line-5\nline-6\nline-7')
    expect(result.omittedLines).toBe(1)
    expect(result.totalLines).toBe(7)
  })

  it('clips a head or tail that is within its line budget but over its char budget', () => {
    const text = numbered(4, 10)
    const result = headTail(text, { headLines: 3, headChars: 15, tailLines: 3, tailChars: 15 })
    expect(result.head).toBe('line-1....')
    expect(result.tail).toBe('line-4....')
    expect(result.omittedLines).toBe(2)
    expect(result.totalLines).toBe(4)
  })

  it('gives the tail its budget first, since errors live there', () => {
    const result = headTail(numbered(10, 10), { headLines: 40, headChars: 30, tailLines: 80, tailChars: 32 })
    expect(result.tail).toBe('line-8....\nline-9....\nline-10...')
    expect(result.head).toBe('line-1....\nline-2....')
    expect(result.omittedLines).toBe(5)
  })

  it('shows fragments of a single oversized line and counts it as omitted', () => {
    const result = headTail('x'.repeat(100), { headLines: 2, headChars: 10, tailLines: 2, tailChars: 20 })
    expect(result.head).toBe('x'.repeat(10))
    expect(result.tail).toBe('x'.repeat(20))
    expect(result.omittedLines).toBe(1)
    expect(result.totalLines).toBe(1)
  })

  it('measures bytes as UTF-8 and an empty text as nothing', () => {
    expect(headTail('é\n', BOUNDS)).toEqual({ head: 'é', tail: '', omittedLines: 0, totalLines: 1, totalBytes: 3 })
    expect(headTail('', BOUNDS)).toEqual({ head: '', tail: '', omittedLines: 0, totalLines: 0, totalBytes: 0 })
  })
})
