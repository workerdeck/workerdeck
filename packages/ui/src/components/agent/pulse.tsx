import { useEffect, useState } from 'react'

export const PULSE_FRAMES = ['⋄', '◇', '◈', '◆'] as const
export const PULSE_MS = 150

export const PULSE_REST = PULSE_FRAMES[PULSE_FRAMES.length - 1]

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
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!running) {
      return
    }
    const timer = setInterval(() => setFrame((f) => f + 1), PULSE_MS)
    return () => clearInterval(timer)
  }, [running])
  if (!running) {
    return PULSE_REST
  }
  return PULSE_FRAMES[frame % PULSE_FRAMES.length]!
}
