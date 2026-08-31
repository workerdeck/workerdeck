import { describe, expect, it } from 'vitest'
import {
  currentText,
  initialOpenFilesState,
  isDirty,
  openFilesReducer,
  type OpenFilesAction,
  type OpenFilesState,
} from '../src/lib/open-files.ts'

function run(actions: OpenFilesAction[], from: OpenFilesState = initialOpenFilesState) {
  return actions.reduce(openFilesReducer, from)
}

function paths(state: OpenFilesState) {
  return state.files.map((f) => f.path)
}

function loaded(path: string, content = 'hello', encoding: 'utf8' | 'base64' = 'utf8') {
  return {
    type: 'loaded',
    path,
    content,
    encoding,
    bytes: content.length,
    hash: `hash-${path}`,
    modifiedAt: 1,
  } satisfies OpenFilesAction
}

describe('openFilesReducer', () => {
  it('opens a tab in the loading state and focuses it', () => {
    const state = run([{ type: 'open', path: '/p/src/a.ts' }])
    expect(state.files).toEqual([{ path: '/p/src/a.ts', name: 'a.ts', status: 'loading' }])
    expect(state.activePath).toBe('/p/src/a.ts')
  })

  it('appends tabs in the order they were opened', () => {
    const state = run([
      { type: 'open', path: '/p/a.ts' },
      { type: 'open', path: '/p/b.ts' },
      { type: 'open', path: '/p/c.ts' },
    ])
    expect(paths(state)).toEqual(['/p/a.ts', '/p/b.ts', '/p/c.ts'])
    expect(state.activePath).toBe('/p/c.ts')
  })

  it('focuses an already-open path instead of reading it again', () => {
    const opened = run([{ type: 'open', path: '/p/a.ts' }, loaded('/p/a.ts', 'contents'), { type: 'open', path: '/p/b.ts' }])
    const reopened = openFilesReducer(opened, { type: 'open', path: '/p/a.ts' })
    expect(paths(reopened)).toEqual(['/p/a.ts', '/p/b.ts'])
    expect(reopened.activePath).toBe('/p/a.ts')
    expect(reopened.files[0]).toMatchObject({ status: 'ready', content: 'contents' })
  })

  it('keeps the focused tab when a background tab closes', () => {
    const state = run([
      { type: 'open', path: '/p/a.ts' },
      { type: 'open', path: '/p/b.ts' },
      { type: 'activate', path: '/p/a.ts' },
      { type: 'close', path: '/p/b.ts' },
    ])
    expect(state.activePath).toBe('/p/a.ts')
  })

  it('moves focus right when the focused tab closes', () => {
    const state = run([
      { type: 'open', path: '/p/a.ts' },
      { type: 'open', path: '/p/b.ts' },
      { type: 'open', path: '/p/c.ts' },
      { type: 'activate', path: '/p/b.ts' },
      { type: 'close', path: '/p/b.ts' },
    ])
    expect(paths(state)).toEqual(['/p/a.ts', '/p/c.ts'])
    expect(state.activePath).toBe('/p/c.ts')
  })

  it('falls back to the left when the last tab closes', () => {
    const state = run([
      { type: 'open', path: '/p/a.ts' },
      { type: 'open', path: '/p/b.ts' },
      { type: 'close', path: '/p/b.ts' },
    ])
    expect(state.activePath).toBe('/p/a.ts')
  })

  it('leaves nothing focused once the last tab is gone', () => {
    const state = run([
      { type: 'open', path: '/p/a.ts' },
      { type: 'close', path: '/p/a.ts' },
    ])
    expect(state.files).toEqual([])
    expect(state.activePath).toBeUndefined()
  })

  it('marks a base64 read as binary rather than showing the base64', () => {
    const state = run([{ type: 'open', path: '/p/logo.png' }, loaded('/p/logo.png', 'AAAA', 'base64')])
    expect(state.files[0]).toMatchObject({ status: 'binary', content: undefined })
  })

  it('carries the hash a later conditional write will need', () => {
    const state = run([{ type: 'open', path: '/p/a.ts' }, loaded('/p/a.ts')])
    expect(state.files[0]?.hash).toBe('hash-/p/a.ts')
  })

  it('drops a read that lands after its tab was closed', () => {
    const state = run([{ type: 'open', path: '/p/a.ts' }, { type: 'close', path: '/p/a.ts' }, loaded('/p/a.ts')])
    expect(state.files).toEqual([])
  })

  it('records a failed read on the tab that asked for it', () => {
    const state = run([
      { type: 'open', path: '/p/a.ts' },
      { type: 'failed', path: '/p/a.ts', error: 'File too large' },
    ])
    expect(state.files[0]).toMatchObject({ status: 'error', error: 'File too large' })
  })

  it('ignores activating a path that is not open', () => {
    const state = run([{ type: 'open', path: '/p/a.ts' }])
    expect(openFilesReducer(state, { type: 'activate', path: '/p/nope.ts' })).toBe(state)
  })

  it('returns the same state when an action changes nothing', () => {
    const state = run([{ type: 'open', path: '/p/a.ts' }])
    expect(openFilesReducer(state, { type: 'open', path: '/p/a.ts' })).toBe(state)
    expect(openFilesReducer(state, { type: 'close', path: '/p/gone.ts' })).toBe(state)
  })
})

function edited(draft = 'changed') {
  return run([{ type: 'open', path: '/p/a.ts' }, loaded('/p/a.ts', 'original'), { type: 'edit', path: '/p/a.ts', content: draft }])
}

function only(state: OpenFilesState) {
  return state.files[0]!
}

describe('openFilesReducer — editing', () => {
  it('keeps the draft separate from what was read', () => {
    const file = only(edited())
    expect(file.content).toBe('original')
    expect(file.draft).toBe('changed')
    expect(currentText(file)).toBe('changed')
    expect(isDirty(file)).toBe(true)
  })

  it('is not dirty once the draft is typed back to what was read', () => {
    const state = openFilesReducer(edited(), {
      type: 'edit',
      path: '/p/a.ts',
      content: 'original',
    })
    expect(isDirty(only(state))).toBe(false)
  })

  it('refuses to edit a binary tab — saving it back as utf8 would corrupt it', () => {
    const state = run([
      { type: 'open', path: '/p/logo.png' },
      loaded('/p/logo.png', 'AAAA', 'base64'),
      { type: 'edit', path: '/p/logo.png', content: 'oops' },
    ])
    expect(only(state).draft).toBeUndefined()
  })

  it('reverts to what was read without touching the hash', () => {
    const state = openFilesReducer(edited(), { type: 'revert', path: '/p/a.ts' })
    expect(only(state)).toMatchObject({ draft: undefined, content: 'original', hash: 'hash-/p/a.ts' })
    expect(isDirty(only(state))).toBe(false)
  })

  it('carries the new hash forward after a save, ready for the next write', () => {
    const state = run(
      [
        { type: 'saveStart', path: '/p/a.ts' },
        {
          type: 'saved',
          path: '/p/a.ts',
          content: 'changed',
          bytes: 7,
          hash: 'hash-2',
          modifiedAt: 2,
        },
      ],
      edited(),
    )
    expect(only(state)).toMatchObject({
      content: 'changed',
      draft: undefined,
      hash: 'hash-2',
      saving: false,
    })
    expect(isDirty(only(state))).toBe(false)
  })

  it('keeps keystrokes that landed while the save was in flight', () => {
    const state = run(
      [
        { type: 'saveStart', path: '/p/a.ts' },
        { type: 'edit', path: '/p/a.ts', content: 'changed more' },
        {
          type: 'saved',
          path: '/p/a.ts',
          content: 'changed',
          bytes: 7,
          hash: 'hash-2',
          modifiedAt: 2,
        },
      ],
      edited(),
    )
    const file = only(state)
    expect(file.content).toBe('changed')
    expect(file.draft).toBe('changed more')
    expect(isDirty(file)).toBe(true)
  })

  it('marks a 409 as a conflict rather than a plain error', () => {
    const state = run(
      [
        { type: 'saveStart', path: '/p/a.ts' },
        { type: 'saveFailed', path: '/p/a.ts', error: 'changed on disk', conflict: true },
      ],
      edited(),
    )
    expect(only(state)).toMatchObject({ conflict: true, saving: false })
    expect(only(state).draft).toBe('changed')
  })

  it('does not treat an ordinary save failure as a conflict', () => {
    const state = run(
      [
        { type: 'saveStart', path: '/p/a.ts' },
        { type: 'saveFailed', path: '/p/a.ts', error: 'File too large' },
      ],
      edited(),
    )
    expect(only(state)).toMatchObject({ conflict: false, saveError: 'File too large' })
  })

  it('clears a previous failure when the next save starts', () => {
    const state = run(
      [
        { type: 'saveStart', path: '/p/a.ts' },
        { type: 'saveFailed', path: '/p/a.ts', error: 'nope', conflict: true },
        { type: 'saveStart', path: '/p/a.ts' },
      ],
      edited(),
    )
    expect(only(state)).toMatchObject({ saving: true, conflict: false, saveError: undefined })
  })

  it('replaces the draft on an explicit reload, which is the only way to lose edits', () => {
    const state = openFilesReducer(edited(), loaded('/p/a.ts', 'what the agent wrote'))
    expect(only(state).content).toBe('what the agent wrote')
    expect(only(state).draft).toBeUndefined()
    expect(isDirty(only(state))).toBe(false)
  })

  it('dismissing a conflict keeps the edits and stops the banner', () => {
    const state = run(
      [
        { type: 'saveFailed', path: '/p/a.ts', error: 'changed on disk', conflict: true },
        { type: 'dismissConflict', path: '/p/a.ts' },
      ],
      edited(),
    )
    expect(only(state)).toMatchObject({ conflict: false, saveError: undefined, draft: 'changed' })
  })

  it('drops a save that lands after its tab was closed', () => {
    const state = run(
      [
        { type: 'close', path: '/p/a.ts' },
        {
          type: 'saved',
          path: '/p/a.ts',
          content: 'changed',
          bytes: 7,
          hash: 'hash-2',
          modifiedAt: 2,
        },
      ],
      edited(),
    )
    expect(state.files).toEqual([])
  })
})
