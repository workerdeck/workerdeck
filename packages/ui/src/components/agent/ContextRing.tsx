import type { ContextReading } from '@workerdeck/protocol'
import { ProgressRing } from '../ui/ProgressRing.tsx'
import { cn } from '../../lib/utils.ts'
import { formatTokens } from '../../lib/format.ts'
import { meterColorClass } from '../../lib/status.ts'

/**
 * How full a session's context window is, sized for a **list row**.
 *
 * The reading the session screen has always drawn, moved somewhere it answers a
 * question the session screen cannot: *which* of these thirty sessions is
 * bloating. That is also why it is a ring and not a number — across a list, a
 * ring is read at a glance and `71%` has to be read one row at a time.
 *
 * **Absent draws nothing, and absent is not zero.** A promptless session, a
 * parked one from before the field existed, or an engine that reports no window
 * has no reading; an empty ring would claim its context is empty rather than
 * unknown. The title carries the exact numbers for anyone who wants them.
 *
 * Shared rather than spelled per client: the dashboard's row and the VS Code
 * sidebar's card both draw it, and two copies would be two sets of thresholds
 * the day one of them is nudged.
 */
export function ContextRing({
  usage,
  size = 11,
  className,
}: {
  usage: ContextReading | undefined
  size?: number
  className?: string
}) {
  if (usage === undefined) return null
  return (
    <span
      title={`Context ${usage.percentage.toFixed(0)}% · ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens)}`}
      className={cn('shrink-0 leading-none', meterColorClass(usage.percentage), className)}>
      <ProgressRing value={usage.percentage} size={size} strokeWidth={2} />
    </span>
  )
}
