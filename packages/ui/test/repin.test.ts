import { describe, expect, it } from 'vitest'
import type { StickToBottomState } from 'use-stick-to-bottom'
import { absorbScrollerResize, REPIN_HOLD_MS, repinToBottom } from '../src/components/agent/use-transcript-jumps.ts'

// The send re-pin's contract against `use-stick-to-bottom`. The scenario that broke the
// previous fix (`scrollToBottom('instant')` alone): the user scrolls up, sends, and one
// trailing momentum wheel tick lands in the same task as the send - one frame before the
// library installs its own animation record. The library's `handleWheel` escape guard reads
// `!state.animation?.ignoreEscapes`, so everything below is about what the state looks like
// *synchronously after* the repin call, not after a frame.

function fakeStick(overrides: Partial<StickToBottomState> = {}) {
  const scrollWrites: number[] = []
  const calls: unknown[] = []
  const state = {
    escapedFromLock: true,
    isAtBottom: false,
    animation: undefined,
    resizeDifference: 0,
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
    // real record behind a rAF (which this test never runs - that gap IS the bug).
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

// The other half of the same bug, past the hold: a composer collapsing after send, or an
// interrupt hint leaving at the turn's end, grows the scroller, the browser clamps `scrollTop`
// down, and `handleScroll` reads the clamp as a scroll up. `resizeDifference` is the library's
// own way of saying "ignore this one", and only its content observer ever sets it.
describe('absorbScrollerResize', () => {
  // The deferred clear mirrors the library's own: a frame, then a task.
  globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number) as typeof requestAnimationFrame

  it('flags the resize so the clamp is not read as escape intent', () => {
    const stick = fakeStick({ isAtBottom: true, escapedFromLock: false })
    absorbScrollerResize(stick, 56)
    expect(stick.state.resizeDifference).toBe(56)
  })

  it('restores the bottom through the library when no pin is held', () => {
    const stick = fakeStick({ isAtBottom: true, escapedFromLock: false })
    absorbScrollerResize(stick, 56)
    expect(stick.calls).toEqual(['instant'])
  })

  it('leaves a live send pin alone and presses the scroll by hand', () => {
    const stick = fakeStick({ isAtBottom: true, escapedFromLock: false })
    repinToBottom(stick)
    const held = stick.state.animation
    absorbScrollerResize(stick, 56)
    expect(stick.state.animation).toBe(held)
    expect(stick.scrollWrites).toEqual([4321, 4321])
  })
})
