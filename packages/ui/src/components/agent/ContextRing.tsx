import type { ContextReading, ProfileEngine } from '@workerdeck/protocol'
import { ProgressRing } from '../ui/ProgressRing.tsx'
import { Tip } from '../ui/Tooltip.tsx'
import { cn } from '../../lib/utils.ts'
import { formatTokens } from '../../lib/format.ts'
import { contextNote } from '../../lib/context-note.ts'
import { meterColorClass } from '../../lib/status.ts'

export function ContextRing({
  usage,
  engine,
  size = 11,
  className,
}: {
  usage: ContextReading | undefined
  engine?: ProfileEngine
  size?: number
  className?: string
}) {
  if (usage === undefined) {
    return null
  }
  const note = contextNote(engine)
  const reading = `Context ${usage.percentage.toFixed(0)}% · ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens)}`
  const shell = cn('shrink-0 leading-none', meterColorClass(usage.percentage), className)
  const ring = <ProgressRing value={usage.percentage} size={size} strokeWidth={2} />
  if (!note) {
    return (
      <span title={reading} className={shell}>
        {ring}
      </span>
    )
  }
  return (
    <Tip
      render={<span className={shell} />}
      content={
        <div className="flex max-w-64 flex-col gap-1 py-0.5">
          <span className="font-mono text-fg-2">{reading}</span>
          <span className="text-fg-3">{note.summary}</span>
          <span className="text-fg-3">{note.hint}</span>
        </div>
      }
    >
      {ring}
    </Tip>
  )
}
