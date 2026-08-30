import { useEffect, useState } from 'react'
import type { UsageWindowRow } from '@workerdeck/protocol'
import { RotateCcw } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { formatAgoPrecise, formatCountdown, formatRateLimitWindowLong, rateLimitWindowSeconds } from '../../lib/format.ts'

/** Ticking clock for the countdowns and pace markers — a minute is the finest
 * resolution either prints. `active` is what a dialog passes its `open`. */
export function useMinuteClock(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const usageTint = (pct: number) => (pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-accent')

/**
 * The plan's rate-limit windows: how much of each is used, how that compares to
 * the pace that would spend the window exactly, and when it resets.
 *
 * The duration behind the pace marker comes from the window key (5h, 7d) —
 * the engine reports a reset time and a percentage and never a duration, so a
 * window whose key doesn't say gets no marker rather than a guessed one.
 */
export function UsageMeters({
  windows,
  now,
  className,
}: {
  /** In reading order — protocol's `orderUsageWindows`. */
  windows: UsageWindowRow[]
  /** A shared clock, when the caller already ticks one; otherwise this ticks
   * its own while mounted. */
  now?: number
  className?: string
}) {
  const ownClock = useMinuteClock(now === undefined)
  const clock = now ?? ownClock
  return (
    <div className={cn('flex flex-col gap-5', className)}>
      {windows.map((window) => (
        <UsageMeter key={window.key} window={window} now={clock} />
      ))}
    </div>
  )
}

const UsageMeter = ({ window, now }: { window: UsageWindowRow; now: number }) => {
  const { key: windowKey, info, updatedAt, inferredReset } = window
  const utilization = info.utilization ?? 0
  const resetsAtMs = info.resetsAt !== undefined ? info.resetsAt * 1000 : undefined
  // Share of the window already elapsed — where usage *would* be if it were
  // spent evenly. Needs both a duration (from the key) and a reset time.
  const duration = rateLimitWindowSeconds(windowKey)
  const remaining = resetsAtMs !== undefined ? (resetsAtMs - now) / 1000 : undefined
  const pace =
    duration !== undefined && remaining !== undefined && remaining > 0 && remaining < duration
      ? (duration - remaining) / duration
      : undefined
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-body-sm text-fg-1">{formatRateLimitWindowLong(windowKey)}</span>
        <span className={cn('shrink-0 font-mono text-body-sm font-medium', info.status === 'rejected' ? 'text-danger' : 'text-fg-1')}>
          {utilization.toFixed(0)}% used
        </span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-border">
        <div
          className={cn('h-full rounded-full', usageTint(utilization))}
          // A floor, so a barely-touched window still shows a mark instead of
          // reading as missing data.
          style={{ width: `${Math.min(100, Math.max(2, utilization))}%` }}
        />
        {pace !== undefined ? (
          <span
            aria-hidden
            title="Spent evenly, usage would be here by now"
            className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-fg-1"
            style={{ left: `${Math.min(100, Math.max(0, pace * 100))}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-label text-fg-4">
        {resetsAtMs !== undefined ? (
          <span className="inline-flex items-center gap-1">
            <RotateCcw className="size-3" /> Resets in {formatCountdown(resetsAtMs, now)}
          </span>
        ) : null}
        {info.isUsingOverage ? <span className="text-warning">overage</span> : null}
        {info.status === 'rejected' ? <span className="text-danger">limit reached</span> : null}
        {/* The gateway zeroed this because the reading's own reset time passed
            with nothing newer, so 0 is a floor. */}
        {inferredReset ? <span>window reset · nothing reported since</span> : null}
        {/* Per window: readings do not share one clock. */}
        {updatedAt && !inferredReset ? <span>{formatAgoPrecise(updatedAt, now)}</span> : null}
      </div>
    </div>
  )
}
