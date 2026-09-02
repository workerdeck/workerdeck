import { describe, expect, it } from 'vitest'
import { contextNote } from '../src/lib/context-note.ts'

describe('contextNote', () => {
  it('explains the window only for codex', () => {
    expect(contextNote('codex')).toBeDefined()
    expect(contextNote('claude')).toBeUndefined()
    expect(contextNote('provider')).toBeUndefined()
  })

  it('reads an absent engine as claude', () => {
    expect(contextNote(undefined)).toBeUndefined()
  })

  it('keeps the load-bearing numbers and the compaction caveat', () => {
    const note = contextNote('codex')
    const all = [note?.summary, note?.hint, ...(note?.detail ?? []), note?.caveat].join(' ')
    for (const fact of [
      '272K',
      '~258k',
      'model_context_window',
      '~/.codex/config.toml',
      '872000',
      '828400',
      '922,000',
      '2x input / 1.5x output',
    ]) {
      expect(all).toContain(fact)
    }
    expect(note?.caveat).toMatch(/compaction/i)
    expect(note?.hint).toMatch(/watch for/i)
  })
})
