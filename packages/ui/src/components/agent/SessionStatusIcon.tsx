import { BellRing, CircleAlert, CircleSlash, Moon, PauseCircle } from 'lucide-react'
import type { SessionRow } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

/**
 * Session state as one glyph.
 *
 * **Reads `row.state`, not `info.status`:** `sessionState` folds in what this
 * glyph cannot see — a background sub-agent outlives its turn, so `status`
 * comes to rest at `idle` while the agent keeps working. The terminal statuses
 * still come off `info.status`, because `ended` collapses `failed` and `closed`
 * into one bucket and those are worth telling apart here.
 */
export function SessionStatusIcon({ row, className }: { row: SessionRow; className?: string }) {
  const { info } = row
  const size = cn('size-4 shrink-0', className)
  if (row.state === 'attention') {
    return <BellRing className={cn(size, 'animate-pulse text-warning')} />
  }
  if (row.state === 'working') {
    return <Spinner className={cn(size, 'text-info')} />
  }
  switch (info.status) {
    case 'failed':
      return <CircleAlert className={cn(size, 'text-danger')} />
    case 'closed':
      return <CircleSlash className={cn(size, 'text-fg-4')} />
    case 'parked':
      return <PauseCircle className={cn(size, 'text-fg-3')} />
    default:
      return <Moon className={cn(size, 'text-fg-4')} />
  }
}
