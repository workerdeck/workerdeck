import { useEffect, useState } from 'react'
import type { ProfileEngine, RateLimitInfo } from '@workerdeck/protocol'
import { RotateCcw } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { cn } from '../../lib/utils.ts'
import {
  formatAgoPrecise,
  formatCost,
  formatCountdown,
  formatRateLimitWindowLong,
  rateLimitWindowSeconds,
} from '../../lib/format.ts'

export interface UsageDialogProps {
  /** Windows in reading order — session, weekly, then per-model weeklies. */
  rateLimits: Array<{ key: string; info: RateLimitInfo }>
  /** claude.ai plan behind the windows ('max', 'pro', …), when there is one. */
  subscriptionType?: string
  engine: ProfileEngine
  totalCostUsd: number
  /** Local receipt time of the last window update. `rate_limit` events are one
   * per turn at best, so a stale reading is normal and worth saying out loud. */
  updatedAt?: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Ticking clock — the countdowns and the pace markers both move with it, and a
 * minute is the finest resolution either of them prints. */
function useMinuteClock(open: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [open])
  return now
}

const usageTint = (pct: number) => (pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-accent')

/**
 * The plan's rate-limit windows, spelled out: how much of each is used, how that
 * compares to the pace that would spend the window exactly, and when it resets.
 *
 * The pace marker is the point. A bar alone says "17% used", which is only
 * alarming or reassuring once you know how far into the week you are — so every
 * window draws a tick at the elapsed share of its duration. Left of the tick is
 * under budget, right of it is ahead of it. The duration comes from the window
 * key (5h, 7d) because the CLI reports a reset time and a percentage and never a
 * duration; a window whose key doesn't say gets no marker rather than a guessed one.
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
            <div className='flex flex-col gap-5'>
              {rateLimits.map(({ key, info }) => (
                <UsageWindow key={key} windowKey={key} info={info} now={now} />
              ))}
            </div>
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

function UsageWindow({
  windowKey,
  info,
  now,
}: {
  windowKey: string
  info: RateLimitInfo
  now: number
}) {
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
      <div className='flex items-baseline justify-between gap-3'>
        <span className='truncate text-body-sm text-fg-1'>
          {formatRateLimitWindowLong(windowKey)}
        </span>
        <span
          className={cn(
            'shrink-0 font-mono text-body-sm font-medium',
            info.status === 'rejected' ? 'text-danger' : 'text-fg-1',
          )}>
          {utilization.toFixed(0)}% used
        </span>
      </div>
      <div className='relative mt-2 h-2 rounded-full bg-border'>
        <div
          className={cn('h-full rounded-full', usageTint(utilization))}
          // A floor, so a barely-touched window still shows a mark instead of
          // reading as missing data.
          style={{ width: `${Math.min(100, Math.max(2, utilization))}%` }}
        />
        {pace !== undefined ? (
          <span
            aria-hidden
            title='Spent evenly, usage would be here by now'
            className='absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-fg-1'
            style={{ left: `${Math.min(100, Math.max(0, pace * 100))}%` }}
          />
        ) : null}
      </div>
      <div className='mt-1.5 flex items-center gap-3 text-label text-fg-4'>
        {resetsAtMs !== undefined ? (
          <span className='inline-flex items-center gap-1'>
            <RotateCcw className='size-3' /> Resets in {formatCountdown(resetsAtMs, now)}
          </span>
        ) : null}
        {info.isUsingOverage ? <span className='text-warning'>overage</span> : null}
        {info.status === 'rejected' ? <span className='text-danger'>limit reached</span> : null}
      </div>
    </div>
  )
}
