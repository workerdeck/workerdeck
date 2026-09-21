import { describe, expect, it } from 'vitest'
import { scanPeerMentions } from '@workerdeck/protocol'
import { scanPromptTokens } from '../src/lib/prompt-tokens.ts'

function texts(input: string) {
  return scanPromptTokens(input).map((t) => t.text)
}

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

  it('ignores an @ that is not at a word start - an email is not a mention', () => {
    expect(texts('mail tobias@atomic.bi about it')).toEqual([])
  })

  it('does not mistake an absolute path for a command', () => {
    expect(texts('/Users/me/notes is where it lives')).toEqual([])
    expect(texts('/dev:wrapup')).toEqual(['/dev:wrapup'])
  })

  it('ignores a bare prefix - in a sent message that is just an at sign', () => {
    expect(texts('a @ b / c')).toEqual([])
  })

  it('finds a command anywhere, not only at the front', () => {
    expect(texts('then /verify-content 42')).toEqual(['/verify-content'])
  })

  it('badges a $name only when the session listed that skill', () => {
    expect(texts('run $pdf on $10 of $unknown')).toEqual([])
    expect(scanPromptTokens('run $pdf on $10 of $unknown.', { skills: ['pdf', 'unknown'] }).map((t) => [t.kind, t.text])).toEqual([
      ['skill', '$pdf'],
      ['skill', '$unknown'],
    ])
    expect(scanPromptTokens('($pdf), $pdf!', { skills: ['pdf'] }).map((t) => t.text)).toEqual(['$pdf'])
    expect(scanPromptTokens('x$pdf $pdfx', { skills: ['pdf'] })).toEqual([])
  })

  it('badges a #Name only for a session this client can name, folded the way the gateway folds it', () => {
    const sessions = ['astra', 'fix-login-bug']
    expect(texts('ask #Astra about it')).toEqual([])
    expect(scanPromptTokens('ask #Astra and #fix_login_bug, not #ff0000 or #1', { sessions }).map((t) => [t.kind, t.text])).toEqual([
      ['session', '#Astra'],
      ['session', '#fix_login_bug'],
    ])
    // A leading bracket is part of the word, so only the bare one is a token - the same rule `$name` follows.
    expect(scanPromptTokens('(#Astra), #Astra!', { sessions }).map((t) => t.text)).toEqual(['#Astra'])
    expect(scanPromptTokens('issue#Astra #-x # Astra', { sessions })).toEqual([])
  })

  it('reads the sigils side by side in source order', () => {
    const tokens = scanPromptTokens('/compact @src/app.ts $pdf #Astra', { skills: ['pdf'], sessions: ['astra'] })
    expect(tokens.map((t) => t.kind)).toEqual(['command', 'file', 'skill', 'session'])
  })

  it('agrees with the gateway about where a mention starts and ends', () => {
    const text = 'commit what #Astra did, then ping #fix-login-bug.'
    const mine = scanPromptTokens(text, { sessions: ['astra', 'fix-login-bug'] })
    expect(mine.map((t) => [t.start, t.end])).toEqual(scanPeerMentions(text).map((t) => [t.start, t.end]))
  })
})
