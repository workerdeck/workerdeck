import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils.ts'
import { formatDuration, formatTokens } from '../../lib/format.ts'
import { LineGlyph, useLines } from './transcript-variant.tsx'

export interface LoaderProps {
  /** Overrides the cycling verb — for a state that has one true name
   * ("Starting session…"). */
  label?: string
  /** When the current run began, for the elapsed clock. Absent = no clock. */
  startedAt?: number
  /** Context tokens in play, shown beside the clock. */
  tokens?: number
  className?: string
}

/**
 * The frames of the working marker, and the rate they turn over.
 *
 * A four-pointed star growing and shrinking — it reads as *activity* at a glance
 * without any of the pixel-fitting a braille or block spinner needs, and it is
 * the same shape a terminal agent uses because a terminal is where this
 * vocabulary comes from. ~8fps: fast enough to be alive, slow enough not to
 * strobe next to streaming text.
 */
const FRAMES = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳']
const FRAME_MS = 120

/**
 * What it says it is doing while it hasn't said anything yet. Cycled on a slow
 * clock so a long turn doesn't sit under one frozen word — a still label reads
 * as a hung process, which is exactly what this is meant to disprove.
 */
const VERBS = [
  'Working',
  'Thinking',
  'Churning',
  'Pondering',
  'Whirring',
  'Computing',
  'Percolating',
  'Tinkering',
  'Deliberating',
  'Simmering',
  'Crunching',
  'Noodling',
]
const VERB_MS = 4000

/** Ticks while mounted, at the spinner's rate. Mounted only while a turn is in
 * flight, so nothing here runs on an idle session. */
function useFrames(animated: boolean): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!animated) return
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [animated])
  return frame
}

/** The OS-level "stop moving things" setting. A spinner is decoration; the word
 * beside it carries the meaning, so honouring this costs nothing. */
function usePrefersReducedMotion(): boolean {
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
 * "The agent is working and hasn't produced output yet."
 *
 * `lines`: a terminal working line — animated glyph in the gutter, a verb, and
 * the readings that answer "should I still be waiting?" in one parenthesis.
 * `cards`: the three-dot pulse, unchanged.
 */
export function Loader({ label, startedAt, tokens, className }: LoaderProps) {
  const lines = useLines()
  const reducedMotion = usePrefersReducedMotion()
  const frame = useFrames(lines && !reducedMotion)

  if (!lines) {
    return (
      <div
        data-slot='loader'
        className={cn('flex items-center gap-2 py-1 text-body-sm text-fg-4', className)}>
        <span className='flex items-center gap-1'>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className='size-1.5 animate-pulse rounded-full bg-fg-4'
              style={{ animationDelay: `${i * 160}ms` }}
            />
          ))}
        </span>
        {label ? <span>{label}</span> : null}
      </div>
    )
  }

  // Derived from the clock rather than kept in state: the frame tick is already
  // re-rendering, so the seconds and the verb come along for free.
  const elapsed = startedAt === undefined ? undefined : Date.now() - startedAt
  const verb =
    label ?? VERBS[Math.floor((elapsed ?? 0) / VERB_MS) % VERBS.length] ?? VERBS[0]
  const readings = [
    elapsed !== undefined ? formatDuration(elapsed) : undefined,
    tokens !== undefined ? `↓ ${formatTokens(tokens)}` : undefined,
  ].filter(Boolean)

  return (
    <div data-slot='loader' className={cn('flex items-baseline gap-2', className)}>
      <LineGlyph className='text-accent'>{FRAMES[frame % FRAMES.length]}</LineGlyph>
      <span className='min-w-0 flex-1 text-body-sm leading-5 text-fg-3'>
        {verb}…{' '}
        {readings.length ? <span className='text-label text-fg-4'>({readings.join(' · ')})</span> : null}
      </span>
    </div>
  )
}
