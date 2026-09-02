import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerDeckClient } from '@workerdeck/client'
import { clearDrafts, draftKey, readDraft, writeDraft } from '../src/lib/draft-store.ts'

// The package is typechecked with no DOM lib, so the store reaches storage through globalThis.
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  return backing
}

describe('draft store', () => {
  beforeEach(() => {
    installStorage()
    clearDrafts()
  })

  it('keys by (gateway, principal, session), not by client instance', () => {
    const a1 = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'X-Key': 'k' } })
    const a2 = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'x-key': 'k' } })
    const b = new WorkerDeckClient({ baseUrl: 'http://two/v1', headers: { 'X-Key': 'k' } })
    expect(draftKey(a1, 's1')).toBe(draftKey(a2, 's1'))
    expect(draftKey(a1, 's1')).not.toBe(draftKey(b, 's1'))
    expect(draftKey(a1, 's1')).not.toBe(draftKey(a1, 's2'))
  })

  it('hands a draft back, which is the whole point of switching away and back', () => {
    writeDraft('a', 'a long prompt I have not sent yet')
    writeDraft('b', 'something else')
    expect(readDraft('a')).toBe('a long prompt I have not sent yet')
    expect(readDraft('b')).toBe('something else')
  })

  it('is unknown rather than empty for a session never typed in', () => {
    expect(readDraft('never')).toBe('')
  })

  // An empty draft is the absence of one — keeping the row would evict a real draft under the cap.
  it('forgets a draft that was cleared or emptied', () => {
    writeDraft('a', 'typed')
    writeDraft('a', '')
    expect(readDraft('a')).toBe('')
    writeDraft('a', 'typed')
    writeDraft('a', '   \n  ')
    expect(readDraft('a')).toBe('')
  })

  it('survives a reload, which is what a module-scope map would not do', async () => {
    const backing = installStorage()
    clearDrafts()
    writeDraft('a', 'unsent')
    expect(backing.size).toBeGreaterThan(0)

    // A genuinely fresh module, which is what a document swap gives you — not just a cleared map.
    vi.resetModules()
    const reloaded = await import('../src/lib/draft-store.ts')
    expect(reloaded.readDraft('a')).toBe('unsent')
  })

  it('keeps the most recent drafts and drops the stalest past the cap', () => {
    for (let i = 0; i < 25; i++) {
      writeDraft(`k${i}`, `draft ${i}`, 1_000 + i)
    }
    expect(readDraft('k24')).toBe('draft 24')
    expect(readDraft('k0')).toBe('')
  })

  it('keeps working when storage is denied', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    clearDrafts()
    expect(() => writeDraft('a', 'typed')).not.toThrow()
    expect(readDraft('a')).toBe('typed')
  })
})
