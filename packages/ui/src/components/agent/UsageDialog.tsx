import type { ProfileEngine, UsageWindowRow } from '@workerdeck/protocol'
import { Badge } from '../ui/Badge.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { formatAgoPrecise, formatCost } from '../../lib/format.ts'
import { UsageMeters, useMinuteClock } from './UsageMeters.tsx'

export interface UsageDialogProps {
  /**
   * Windows in reading order — session, weekly, then per-model weeklies.
   *
   * `updatedAt`/`inferredReset` ride each window because the readings no longer
   * share one clock: the panel merges the gateway's per-profile state over this
   * session's, so a `five_hour` learned from a sibling session two minutes ago
   * can sit beside a `seven_day` this session last heard about yesterday.
   * `inferredReset` marks the ones the *gateway* zeroed because their own reset
   * time passed with nothing newer — a floor, not a report.
   */
  rateLimits: UsageWindowRow[]
  /** claude.ai plan behind the windows ('max', 'pro', …), when there is one. */
  subscriptionType?: string
  engine: ProfileEngine
  totalCostUsd: number
  /** When the *freshest* of the windows was read, for the footer line. Readings
   * arrive one per turn at best (and for an idle session, not at all), so a
   * stale one is normal and worth saying out loud. */
  updatedAt?: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The session's view of the plan: every window as a meter (see
 * {@link UsageMeters}), the plan tier, and what this session itself has cost.
 */
export function UsageDialog({
  rateLimits,
  subscriptionType,
  engine,
  totalCostUsd,
  updatedAt,
  open,
  onOpenChange,
}: UsageDialogProps) {
  const now = useMinuteClock(open)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title='Usage'
          description={engine === 'claude' ? 'Claude Code' : engine}
          actions={
            // The CLI reports a tier ('max'), never the multiplier a
            // subscription page shows — so this says "Max" and stops there.
            subscriptionType ? (
              <Badge variant='accent' className='mt-0.5 shrink-0 capitalize'>
                {subscriptionType}
              </Badge>
            ) : null
          }
        />
        <DialogBody>
          {rateLimits.length === 0 ? (
            <p className='py-6 text-center text-body-sm text-fg-4'>
              {engine === 'claude'
                ? 'This session reports no plan windows — API-key sessions have none, and a subscription session reports them once a turn has run.'
                : `Plan windows are a claude.ai subscription thing; this session runs on the ${engine} engine.`}
            </p>
          ) : (
            <UsageMeters windows={rateLimits} now={now} />
          )}
          <div className='mt-5 flex items-baseline justify-between gap-4 border-t border-border pt-3'>
            <span className='text-label text-fg-3'>This session has cost</span>
            <span className='font-mono text-body-sm text-fg-1'>{formatCost(totalCostUsd)}</span>
          </div>
          {updatedAt ? (
            <p className='mt-2 text-label text-fg-4'>Updated {formatAgoPrecise(updatedAt, now)}</p>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
