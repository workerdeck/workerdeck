import type { ProfileEngine, UsageWindowRow } from '@workerdeck/protocol'
import { Badge } from '../ui/Badge.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { formatAgoPrecise, formatCost } from '../../lib/format.ts'
import { UsageMeters, useMinuteClock } from './UsageMeters.tsx'

export interface UsageDialogProps {
  rateLimits: UsageWindowRow[]
  subscriptionType?: string
  engine: ProfileEngine
  totalCostUsd: number
  updatedAt?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

export function UsageDialog({
  rateLimits,
  subscriptionType,
  engine,
  totalCostUsd,
  updatedAt,
  open,
  onOpenChange,
  className,
}: UsageDialogProps) {
  const now = useMinuteClock(open)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader
          title="Usage"
          description={engine === 'claude' ? 'Claude Code' : engine}
          actions={
            subscriptionType ? (
              <Badge variant="accent" className="mt-0.5 shrink-0 capitalize">
                {subscriptionType}
              </Badge>
            ) : null
          }
        />
        <DialogBody>
          {rateLimits.length === 0 ? (
            <p className="py-6 text-center text-body-sm text-fg-4">
              {engine === 'claude'
                ? 'This session reports no plan windows — API-key sessions have none, and a subscription session reports them once a turn has run.'
                : `Plan windows are a claude.ai subscription thing; this session runs on the ${engine} engine.`}
            </p>
          ) : (
            <UsageMeters windows={rateLimits} now={now} />
          )}
          <div className="mt-5 flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <span className="text-label text-fg-3">This session has cost</span>
            <span className="font-mono text-body-sm text-fg-1">{formatCost(totalCostUsd)}</span>
          </div>
          {updatedAt ? <p className="mt-2 text-label text-fg-4">Updated {formatAgoPrecise(updatedAt, now)}</p> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
