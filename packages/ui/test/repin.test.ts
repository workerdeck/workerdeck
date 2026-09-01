import { describe, expect, it } from 'vitest'
import type { StickToBottomState } from 'use-stick-to-bottom'
import { REPIN_HOLD_MS, repinToBottom } from '../src/components/agent/use-transcript-jumps.ts'

/**
 * The send re-pin's contract against `use-stick-to-bottom`. The scenario that broke the
 * previous fix (`scrollToBottom('instant')` alone): the user scrolls up, sends, and one
 * trailing momentum wheel tick lands in the same task as the send — one frame before the
 * library installs its own animation record. The library's `handleWheel` escape guard reads
 * `!state.animation?.ignoreEscapes`, so everything below is about what the state looks like
 * *synchronously after* the repin call, not after a frame.
 */

function fakeStick(overrides: Partial<StickToBottomState> = {}) {
  const scrollWrites: number[] = []
  const calls: unknown[] = []
  const state = {
    escapedFromLock: true,
    isAtBottom: false,
    animation: undefined,
    calculatedTargetScrollTop: 4321,
    get scrollTop() {
      return scrollWrites[scrollWrites.length - 1] ?? 0
    },
    set scrollTop(top: number) {
      scrollWrites.push(top)
    },
    ...overrides,
  } as StickToBottomState
  const scrollToBottom = (options?: unknown) => {
    calls.push(options)
    // Mirror the library's synchronous entry: pin, wipe any prior animation, defer the
    // real record behind a rAF (which this test never runs — that gap IS the bug).
    state.isAtBottom = true
    state.animation = undefined
    return Promise.resolve(true)
  }
  return { state, scrollToBottom, scrollWrites, calls }
}

describe('repinToBottom', () => {
  it('clears the stale escape so near-bottom re-arming works again', () => {
    const stick = fakeStick()
    repinToBottom(stick)
    expect(stick.state.escapedFromLock).toBe(false)
  })

  it('holds the pin: instant, escape-proof, and longer-lived than the click', () => {
    const stick = fakeStick()
    repinToBottom(stick)
    expect(stick.calls).toEqual([{ animation: 'instant', ignoreEscapes: true, duration: REPIN_HOLD_MS }])
  })

  it('seeds the ignore-escapes record before the library gets its first frame', () => {
    const stick = fakeStick()
    repinToBottom(stick)
    // A momentum tick processed after the send but before any rAF must see `ignoreEscapes`,
    // or `handleWheel` unpins and the deferred animation aborts without ever scrolling.
    expect(stick.state.animation).toMatchObject({ behavior: 'instant', ignoreEscapes: true })
    expect(stick.state.animation?.promise).toBeInstanceOf(Promise)
  })

  it('presses the scroll synchronously instead of waiting a frame', () => {
    const stick = fakeStick()
    repinToBottom(stick)
    expect(stick.scrollWrites).toEqual([4321])
  })
})
