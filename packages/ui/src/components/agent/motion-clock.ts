import { useEffect } from 'react'

export const MOTION_FRAME_MS = 83
export const MOTION_CLOCK_ATTRIBUTE = 'data-motion-clock'
export const CLOCKED_ANIMATIONS = '.wd-face *, .term-shimmer, .animate-spin, .animate-pulse, .term-scrub-mark, .wd-scrub-mark'

const MAX_STEP_MS = MOTION_FRAME_MS * 4
const HELD = '[data-face-paused] .wd-face *, .wd-face[data-paused] *'

let users = 0
let ticker: ReturnType<typeof setInterval> | undefined
let last = 0

function clocked(animation: Animation): boolean {
  if (!(animation instanceof CSSAnimation) || animation.playState !== 'paused') {
    return false
  }
  const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
  return target !== null && target.matches(CLOCKED_ANIMATIONS) && !target.matches(HELD)
}

export function advanceMotion(animations: Iterable<Animation>, step: number): void {
  for (const animation of animations) {
    if (clocked(animation)) {
      animation.currentTime = Number(animation.currentTime ?? 0) + step
    }
  }
}

function tick(): void {
  const now = performance.now()
  const step = Math.min(now - last, MAX_STEP_MS)
  last = now
  if (!document.hidden) {
    advanceMotion(document.getAnimations(), step)
  }
}

function join(): void {
  users++
  if (ticker === undefined) {
    document.documentElement.setAttribute(MOTION_CLOCK_ATTRIBUTE, '')
    last = performance.now()
    ticker = setInterval(tick, MOTION_FRAME_MS)
  }
}

function leave(): void {
  users--
  if (users === 0 && ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
    document.documentElement.removeAttribute(MOTION_CLOCK_ATTRIBUTE)
  }
}

export function useMotionClock(active = true): void {
  useEffect(() => {
    if (!active) {
      return
    }
    join()
    return leave
  }, [active])
}
