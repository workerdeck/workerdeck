import { BellRing, CircleAlert, CircleSlash, Moon, PauseCircle } from 'lucide-react'
import type { SessionRow } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

/**
 * State as one glyph — a ringing bell when it wants a human, a spinner while it
 * works, a moon when it is only sleeping. Replaces the text badge: in a sidebar
 * the word costs more room than it earns, and the states that matter are the two
 * you can recognise without reading.
 *
 * **It reads `row.state`, not `info.status`, and that distinction is the whole
 * point of the row model.** `sessionState` already folds in the arm this glyph
 * cannot see for itself: a *background* sub-agent outlives its turn by design,
 * so the turn ends, `status` comes to rest at `idle`, and the agent keeps
 * working. Reading the raw status drew a **moon on a row filed under the
 * "Working" header** — the list contradicting itself on one line, which is
 * exactly what a derived view model exists to prevent. The value was in scope
 * and unread.
 *
 * The terminal statuses still come off `info.status`, because `ended` collapses
 * `failed` and `closed` into one bucket and those are worth telling apart here.
 *
 * It lives in its own file rather than inside the dashboard's browser because
 * the extension's cards draw it too, and a second copy there is how the two
 * lists last disagreed about what a parked session looks like.
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
