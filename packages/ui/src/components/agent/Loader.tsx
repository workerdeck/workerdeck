import { cn } from '../../lib/utils.ts'

export interface LoaderProps {
  /** Overrides the cycling verb — for a state that has one true name
   * ("Starting session…"). */
  label?: string
  /** When the current run began, for the elapsed clock. Unused by the card
   * treatment; kept so both loaders take the same call site in `Transcript`. */
  startedAt?: number
  /** Context tokens in play. Same story as `startedAt`. */
  tokens?: number
  className?: string
}

/** "The agent is working and hasn't produced output yet", for the `cards`
 * variant. The terminal theme has its own `WorkingRow`. */
export function Loader({ label, className }: LoaderProps) {
  return (
    <div data-slot="loader" className={cn('flex items-center gap-2 py-1 text-body-sm text-fg-4', className)}>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-pulse rounded-full bg-fg-4" style={{ animationDelay: `${i * 160}ms` }} />
        ))}
      </span>
      {label ? <span>{label}</span> : null}
    </div>
  )
}
