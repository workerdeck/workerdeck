import { cn } from '../../lib/utils.ts'

export interface LoaderProps {
  /** Overrides the cycling verb — for a state that has one true name
   * ("Starting session…"). */
  label?: string
  /** When the current run began, for the elapsed clock. Absent = no clock.
   * Unused by the card treatment; kept so the `cards` and `terminal` loaders
   * take the same call site in `Transcript`. */
  startedAt?: number
  /** Context tokens in play. Same story as `startedAt`. */
  tokens?: number
  className?: string
}

/**
 * "The agent is working and hasn't produced output yet."
 *
 * Three dots pulsing in CSS — the chat convention, for the `cards` variant. The
 * terminal theme has its own working line (`terminal/items.tsx`'s `WorkingRow`,
 * with the mark's pulse in the gutter and the run's readings beside the verb),
 * because there it is a *row of the transcript* rather than a spinner floating
 * over one.
 */
export function Loader({ label, className }: LoaderProps) {
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
