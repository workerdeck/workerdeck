import { describe, expect, it } from 'vitest'
import { findUrls, isOpenGesture } from '../src/lib/terminal-links.ts'

describe('findUrls', () => {
  it('finds every url on a dev server status line, with its offsets', () => {
    const line = '  ✓ running   http://localhost:8190  HMR http://localhost:5190'
    const urls = findUrls(line)
    expect(urls.map((u) => u.url)).toEqual(['http://localhost:8190', 'http://localhost:5190'])
    for (const u of urls) {
      expect(line.slice(u.start, u.end)).toBe(u.url)
    }
  })

  it('drops trailing sentence punctuation and unbalanced closers', () => {
    expect(findUrls('see https://example.com/a.').map((u) => u.url)).toEqual(['https://example.com/a'])
    expect(findUrls('(at https://example.com/x)').map((u) => u.url)).toEqual(['https://example.com/x'])
    expect(findUrls('https://en.wikipedia.org/wiki/A_(b)').map((u) => u.url)).toEqual(['https://en.wikipedia.org/wiki/A_(b)'])
  })

  it('stops at quotes and ignores a bare scheme', () => {
    expect(findUrls('url="https://a.dev/p?q=1"').map((u) => u.url)).toEqual(['https://a.dev/p?q=1'])
    expect(findUrls('http:// nothing')).toEqual([])
  })
})

describe('isOpenGesture', () => {
  it('wants cmd on a mac and ctrl elsewhere', () => {
    expect(isOpenGesture({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isOpenGesture({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isOpenGesture({ metaKey: false, ctrlKey: true }, false)).toBe(true)
  })
})
