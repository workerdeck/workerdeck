import { useEffect, useState } from 'react'
import type { TranscriptState } from '@workerdeck/react'
import type { ContextUsage, RateLimitInfo } from '@workerdeck/protocol'
import { WifiOff } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { ProgressRing } from '../ui/ProgressRing.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { Tip } from '../ui/Tooltip.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatCountdown, formatTokens } from '../../lib/format.ts'
import { STATUS_META } from './status.ts'

export interface StatusBarProps {
  state: TranscriptState
  connected: boolean
  className?: string
}

/** Ticking clock for reset countdowns — rate_limit events are sparse, so tick locally. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

const utilizationColor = (pct: number) =>
  pct >= 95 ? 'text-danger' : pct >= 80 ? 'text-warning' : 'text-fg-3'

/** The CLI reports category colors as its own theme token names ('inactive',
 * 'promptBorder', ...), not CSS colors — only pass through what CSS can render. */
const cssColor = (color: string): string | undefined =>
  typeof CSS !== 'undefined' && CSS.supports('color', color) ? color : undefined

function ContextMeter({ usage }: { usage: ContextUsage }) {
  return (
    <Tip
      content={
        <div className='flex min-w-44 flex-col gap-1 py-0.5'>
          {usage.categories.map((c) => (
            <div key={c.name} className='flex items-center gap-2'>
              <span
                className='size-2 shrink-0 rounded-full bg-fg-4'
                style={cssColor(c.color) ? { backgroundColor: c.color } : undefined}
              />
              <span className='flex-1'>{c.name}</span>
              <span className='font-mono text-fg-3'>{formatTokens(c.tokens)}</span>
            </div>
          ))}
          <div className='mt-0.5 flex items-center justify-between gap-2 border-t border-border pt-1'>
            <span>Total</span>
            <span className='font-mono text-fg-3'>
              {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)} (
              {usage.percentage.toFixed(0)}%)
            </span>
          </div>
        </div>
      }>
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1 font-mono text-label',
          utilizationColor(usage.percentage),
        )}>
        Ctx {formatTokens(usage.totalTokens)}
      </span>
    </Tip>
  )
}

function RateLimitMeter({ label, info, now }: { label: string; info: RateLimitInfo; now: number }) {
  // The CLI omits utilization on some updates — show the window without a made-up 0%.
  const pct = info.utilization
  const resetsAtMs = info.resetsAt !== undefined ? info.resetsAt * 1000 : undefined
  return (
    <Tip
      content={
        <div className='flex min-w-36 flex-col gap-1 py-0.5'>
          <div className='flex items-center justify-between gap-2'>
            <span>{label} usage</span>
            <span className='font-mono text-fg-3'>
              {pct !== undefined ? `${pct.toFixed(1)}%` : '—'}
            </span>
          </div>
          {resetsAtMs !== undefined ? (
            <div className='flex items-center justify-between gap-2'>
              <span>Resets in</span>
              <span className='font-mono text-fg-3'>{formatCountdown(resetsAtMs, now)}</span>
            </div>
          ) : null}
          {info.isUsingOverage ? <div className='text-warning'>Using overage</div> : null}
          {info.status === 'rejected' ? <div className='text-danger'>Limit reached</div> : null}
        </div>
      }>
      <span
        className={cn(
          'inline-flex cursor-default items-center gap-1 font-mono text-label',
          info.status === 'rejected' ? 'text-danger' : utilizationColor(pct ?? 0),
        )}>
        <ProgressRing value={pct ?? 0} />
        {label}
        {pct !== undefined ? ` ${pct.toFixed(0)}%` : ''}
        {resetsAtMs !== undefined ? (
          <span className='text-fg-4'>· {formatCountdown(resetsAtMs, now)}</span>
        ) : null}
      </span>
    </Tip>
  )
}

export function StatusBar({ state, connected, className }: StatusBarProps) {
  const meta = STATUS_META[state.status]
  const now = useNow()
  const session = state.rateLimits?.five_hour
  const weekly = state.rateLimits?.seven_day
  return (
    <div
      data-slot='status-bar'
      className={cn(
        'flex items-center gap-3 border-b border-border bg-surface px-3 py-2',
        className,
      )}>
      <Badge variant={meta.variant} dot={!meta.busy}>
        {meta.busy ? <Spinner className='size-3 text-current' /> : null}
        {meta.label}
      </Badge>
      {state.contextUsage ? <ContextMeter usage={state.contextUsage} /> : null}
      {session ? <RateLimitMeter label='Session' info={session} now={now} /> : null}
      {weekly ? <RateLimitMeter label='Weekly' info={weekly} now={now} /> : null}
      <span className='flex-1' />
      {!connected ? (
        <span className='inline-flex items-center gap-1 text-label text-warning'>
          <WifiOff className='size-3' /> reconnecting…
        </span>
      ) : null}
      <span className='font-mono text-label text-fg-3'>{formatCost(state.totalCostUsd)}</span>
    </div>
  )
}
