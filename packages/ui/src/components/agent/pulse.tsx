import { useEffect, useState } from 'react'

/**
 * The brand mark's pulse as characters (`docs/assets/BRAND.md`, "The loading
 * state"), 150ms a frame so one cycle is the mark's 0.6s clock.
 *
 * `U+25C6/7/8` are East-Asian **ambiguous width**: they can render double-width
 * under an East-Asian locale and shift every line with them. Safe only where
 * the glyph is centred in a fixed-width box (the terminal theme's gutter cell).
 * Anything writing to a real terminal must use the ASCII set instead.
 */
export const PULSE_FRAMES = ['⋄', '◇', '◈', '◆'] as const
export const PULSE_MS = 150

/** The resting state: stopping the animation lands on the complete mark rather
 * than a half-drawn frame. */
export const PULSE_REST = PULSE_FRAMES[PULSE_FRAMES.length - 1]

/** The OS-level "stop moving things" setting. */
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

/** The current pulse frame, ticking while `animated`; holds at rest under
 * reduced motion. */
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
