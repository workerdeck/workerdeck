import { useEffect, useState, useSyncExternalStore } from 'react'

export const PULSE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
export const PULSE_MS = 90

export const PULSE_REST = '⠿'

const listeners = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | undefined
let current = PULSE_REST

export function pulseFrameAt(now: number): string {
  return PULSE_FRAMES[Math.floor(now / PULSE_MS) % PULSE_FRAMES.length]!
}

function tick(): void {
  const next = pulseFrameAt(Date.now())
  if (next === current) {
    return
  }
  current = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (ticker === undefined) {
    current = pulseFrameAt(Date.now())
    ticker = setInterval(tick, PULSE_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && ticker !== undefined) {
      clearInterval(ticker)
      ticker = undefined
    }
  }
}

function subscribeRest(): () => void {
  return unsubscribeRest
}

function unsubscribeRest(): void {}

function readFrame(): string {
  return current
}

function readRest(): string {
  return PULSE_REST
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) {
      return
    }
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function usePulse(animated: boolean): string {
  const reduced = usePrefersReducedMotion()
  const running = animated && !reduced
  return useSyncExternalStore(running ? subscribe : subscribeRest, running ? readFrame : readRest, readRest)
}
