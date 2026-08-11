import { useEffect, useState } from 'react'

/**
 * The brand mark's pulse, as characters — the working marker every surface in the
 * transcript animates.
 *
 * These are the mark's own four states (`docs/assets/BRAND.md`, "The loading
 * state"): a dot, an outline, a semi and a full diamond, built in the SVG from
 * two shapes rather than four drawings. 150ms each, so one cycle is the 0.6s
 * clock the marker pulses on in `icon-loading.svg` — the same rhythm, in the
 * medium a transcript row actually has.
 *
 * BRAND.md's caveat applies and is satisfied here: `U+25C6/7/8` are East-Asian
 * *ambiguous width*, so they can render double-width in a terminal under an
 * East-Asian locale and shift every line with them. They are safe wherever the
 * glyph is centred in a fixed-width box, which is what `LineGlyph` is. Anything
 * writing to a real terminal must use the ASCII set instead.
 */
export const PULSE_FRAMES = ['⋄', '◇', '◈', '◆'] as const
export const PULSE_MS = 150

/**
 * The resting state. Stopping the animation lands on the complete mark rather
 * than on a half-drawn frame — the same property that makes the SVG's
 * `prefers-reduced-motion` free (see BRAND.md: `translateY(0)` *is* the mark).
 */
export const PULSE_REST = PULSE_FRAMES[PULSE_FRAMES.length - 1]

/** The OS-level "stop moving things" setting. A spinner is decoration — the word
 * beside it carries the meaning — so honouring this costs nothing. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * The current pulse frame, ticking while `animated`. Callers mount this only
 * while something is actually in flight, so nothing here runs on an idle
 * session; with reduced motion, or when not animating, it holds at rest.
 */
export function usePulse(animated: boolean): string {
  const reduced = usePrefersReducedMotion()
  const running = animated && !reduced
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setFrame((f) => f + 1), PULSE_MS)
    return () => clearInterval(timer)
  }, [running])
  if (!running) return PULSE_REST
  return PULSE_FRAMES[frame % PULSE_FRAMES.length]!
}
