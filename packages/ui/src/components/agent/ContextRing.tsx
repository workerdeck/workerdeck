import type { ContextReading } from '@workerdeck/protocol'
import { ProgressRing } from '../ui/ProgressRing.tsx'
import { cn } from '../../lib/utils.ts'
import { formatTokens } from '../../lib/format.ts'
import { meterColorClass } from '../../lib/status.ts'

/**
 * How full a session's context window is, sized for a **list row**.
 *
 * **Absent draws nothing, and absent is not zero** — a promptless session, or
 * an engine that reports no window, has no reading, and an empty ring would
 * claim its context is empty rather than unknown.
 */
export function ContextRing({ usage, size = 11, className }: { usage: ContextReading | undefined; size?: number; className?: string }) {
  if (usage === undefined) {
    return null
  }
  return (
    <span
      title={`Context ${usage.percentage.toFixed(0)}% · ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens)}`}
      className={cn('shrink-0 leading-none', meterColorClass(usage.percentage), className)}
    >
      <ProgressRing value={usage.percentage} size={size} strokeWidth={2} />
    </span>
  )
}
