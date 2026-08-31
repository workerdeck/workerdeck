import { describe, expect, it } from 'vitest'
import { scanPromptTokens } from '../src/lib/prompt-tokens.ts'

const texts = (input: string) => scanPromptTokens(input).map((t) => t.text)

describe('scanPromptTokens', () => {
  it('finds file and command tokens at word boundaries', () => {
    expect(texts('look at @src/main.ts then run /commit-message')).toEqual(['@src/main.ts', '/commit-message'])
  })

  it('reports each token’s kind and offsets', () => {
    const [token] = scanPromptTokens('see @README.md')
    expect(token).toEqual({ kind: 'file', start: 4, end: 14, text: '@README.md' })
  })

  it('leaves trailing sentence punctuation out of the token', () => {
    expect(texts('see @README.md.')).toEqual(['@README.md'])
    expect(texts('(check @a.ts), then @b.ts!')).toEqual(['@a.ts', '@b.ts'])
  })

  it('ignores an @ that is not at a word start — an email is not a mention', () => {
    expect(texts('mail tobias@atomic.bi about it')).toEqual([])
  })

  it('does not mistake an absolute path for a command', () => {
    expect(texts('/Users/me/notes is where it lives')).toEqual([])
    expect(texts('/dev:wrapup')).toEqual(['/dev:wrapup'])
  })

  it('ignores a bare prefix — in a sent message that is just an at sign', () => {
    expect(texts('a @ b / c')).toEqual([])
  })

  it('finds a command anywhere, not only at the front', () => {
    expect(texts('then /verify-content 42')).toEqual(['/verify-content'])
  })
})
