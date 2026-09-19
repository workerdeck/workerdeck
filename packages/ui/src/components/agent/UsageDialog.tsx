import type { ByModel, ProfileEngine, ProfileSpend, UsageWindowRow } from '@workerdeck/protocol'
import { PRICING_NOTE } from '@workerdeck/protocol'
import { Badge } from '../ui/Badge.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { formatAgoPrecise, formatCost, formatTokens } from '../../lib/format.ts'
import { type SessionCost, sessionCost } from '../../lib/session-cost.ts'
import { UsageMeters, useMinuteClock } from './UsageMeters.tsx'

export interface UsageDialogProps {
  rateLimits: UsageWindowRow[]
  subscriptionType?: string
  engine: ProfileEngine
  totalCostUsd?: number
  costUsd?: number
  usageByModel?: ByModel
  spend?: ProfileSpend
  updatedAt?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

function Line({ label, value, tone }: { label: string; value: string; tone?: 'muted' }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={tone === 'muted' ? 'text-label text-fg-4' : 'text-label text-fg-3'}>{label}</span>
      <span className={`font-mono text-body-sm ${tone === 'muted' ? 'text-fg-4' : 'text-fg-1'}`}>{value}</span>
    </div>
  )
}

function CostEvidence({ cost, engine }: { cost: SessionCost; engine: ProfileEngine }) {
  const { breakdown, rows } = cost
  if (rows.length === 0) {
    return <Line label="This session has cost" value={formatCost(cost.displayUsd)} />
  }
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-label text-fg-3">This session has cost</span>
        <span className="font-mono text-body text-fg-1">{formatCost(cost.displayUsd)}</span>
      </div>
      <div className="space-y-1 border-t border-border pt-2">
        <Line label="input" value={formatCost(breakdown.input)} tone="muted" />
        <Line label="output" value={formatCost(breakdown.output)} tone="muted" />
        <Line label="cache write" value={formatCost(breakdown.cacheWrite)} tone="muted" />
        <Line label="cache read" value={formatCost(breakdown.cacheRead)} tone="muted" />
      </div>
      <div className="space-y-1 border-t border-border pt-2">
        {rows.map((row) => (
          <div key={row.model} className="flex items-baseline justify-between gap-4">
            <span className="truncate text-label text-fg-4">{row.model}</span>
            <span className="shrink-0 font-mono text-label text-fg-4">
              {formatTokens(row.tokens)} · {row.costUsd === undefined ? 'no rate' : formatCost(row.costUsd)}
            </span>
          </div>
        ))}
      </div>
      {cost.showUnpricedWarning ? (
        <p className="text-label text-warning">
          {Math.round(cost.unpricedShare * 100)}% of these tokens ran on a model with no bundled rate, so the total is an understatement
          rather than an estimate.
        </p>
      ) : null}
      {cost.gapUsd !== undefined ? (
        <p className="text-label text-fg-4">
          {engine === 'claude' ? 'Claude Code' : engine} reports {formatCost(cost.reportedUsd)} for the same tokens.
        </p>
      ) : null}
    </div>
  )
}

function ProfileSpendSection({ spend }: { spend: ProfileSpend }) {
  const { subscription } = spend
  return (
    <div className="mt-4 space-y-1 border-t border-border pt-3">
      <Line label="This profile, last 7 days" value={formatCost(spend.weekUsd)} />
      <Line label="Last 30 days" value={formatCost(spend.monthUsd)} tone="muted" />
      {subscription ? (
        <p className="pt-1 text-label text-fg-4">
          {formatMultiple(subscription.ratio)} the {formatCost(subscription.weeklyShareUsd)} weekly share of your{' '}
          {formatCost(subscription.monthlyUsd)} a month. A subscription is a flat fee, so this is leverage, not a bill.
        </p>
      ) : null}
    </div>
  )
}

function formatMultiple(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}x` : `${ratio.toFixed(1)}x`
}

export function UsageDialog({
  rateLimits,
  subscriptionType,
  engine,
  totalCostUsd,
  costUsd,
  usageByModel,
  spend,
  updatedAt,
  open,
  onOpenChange,
  className,
}: UsageDialogProps) {
  const now = useMinuteClock(open)
  const cost = sessionCost({ costUsd, totalCostUsd, usageByModel })
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
                ? 'This session reports no plan windows - API-key sessions have none, and a subscription session reports them once a turn has run.'
                : `Plan windows are a claude.ai subscription thing; this session runs on the ${engine} engine.`}
            </p>
          ) : (
            <UsageMeters windows={rateLimits} now={now} />
          )}
          <div className="mt-5 border-t border-border pt-3">
            <CostEvidence cost={cost} engine={engine} />
          </div>
          {spend ? <ProfileSpendSection spend={spend} /> : null}
          <p className="mt-3 text-label text-fg-4">{PRICING_NOTE}</p>
          {updatedAt ? <p className="mt-2 text-label text-fg-4">Updated {formatAgoPrecise(updatedAt, now)}</p> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
