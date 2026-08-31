import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionState, TranscriptState } from '@workerdeck/react'
import type { ContextUsage, RateLimitInfo } from '@workerdeck/protocol'
import { RefreshCw, WifiOff } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { ProgressRing } from '../ui/ProgressRing.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { Tip } from '../ui/Tooltip.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatCountdown, formatTokens } from '../../lib/format.ts'
import { meterColorClass } from '../../lib/status.ts'
import { cssColor } from '../../lib/css.ts'
import { STATUS_META } from './status.ts'
import { useTranscriptVariant } from './transcript-variant.tsx'

export interface StatusBarProps {
  state: TranscriptState
  rateLimits?: Record<string, RateLimitInfo>
  /** @deprecated Pass {@link StatusBarProps.connection}. */
  connected?: boolean
  connection?: ConnectionState
  onOpenStatus?: () => void
  onOpenContext?: () => void
  onOpenUsage?: () => void
  controls?: ReactNode
  actions?: ReactNode
  placement?: 'top' | 'bottom'
  className?: string
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function ContextMeter({ usage }: { usage: ContextUsage }) {
  return (
    <Tip
      content={
        <div className="flex min-w-44 flex-col gap-1 py-0.5">
          {usage.categories.map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-fg-4" style={cssColor(c.color) ? { backgroundColor: c.color } : undefined} />
              <span className="flex-1">{c.name}</span>
              <span className="font-mono text-fg-3">{formatTokens(c.tokens)}</span>
            </div>
          ))}
          <div className="mt-0.5 flex items-center justify-between gap-2 border-t border-border pt-1">
            <span>Total</span>
            <span className="font-mono text-fg-3">
              {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)} ({usage.percentage.toFixed(0)}%)
            </span>
          </div>
        </div>
      }
    >
      <span className={cn('inline-flex cursor-default items-center gap-1 font-mono text-label', meterColorClass(usage.percentage))}>
        Ctx {formatTokens(usage.totalTokens)}
      </span>
    </Tip>
  )
}

function RateLimitMeter({ label, info, now }: { label: string; info: RateLimitInfo; now: number }) {
  const pct = info.utilization
  const resetsAtMs = info.resetsAt !== undefined ? info.resetsAt * 1000 : undefined
  return (
    <Tip
      content={
        <div className="flex min-w-36 flex-col gap-1 py-0.5">
          <div className="flex items-center justify-between gap-2">
            <span>{label} usage</span>
            <span className="font-mono text-fg-3">{pct !== undefined ? `${pct.toFixed(1)}%` : '—'}</span>
          </div>
          {resetsAtMs !== undefined ? (
            <div className="flex items-center justify-between gap-2">
              <span>Resets in</span>
              <span className="font-mono text-fg-3">{formatCountdown(resetsAtMs, now)}</span>
            </div>
          ) : null}
          {info.isUsingOverage ? <div className="text-warning">Using overage</div> : null}
          {info.status === 'rejected' ? <div className="text-danger">Limit reached</div> : null}
        </div>
      }
    >
      <span
        className={cn(
          'cursor-default font-mono text-label whitespace-nowrap',
          info.status === 'rejected' ? 'text-danger' : meterColorClass(pct ?? 0),
        )}
      >
        <ProgressRing value={pct ?? 0} className="mr-1 inline-block align-middle" />
        {label}
        {pct !== undefined ? ` ${pct.toFixed(0)}%` : ''}
        {resetsAtMs !== undefined ? <span className="text-fg-4"> · {formatCountdown(resetsAtMs, now)}</span> : null}
      </span>
    </Tip>
  )
}

function Slot({ onClick, hint, children }: { onClick?: () => void; hint: string; children: ReactNode }) {
  if (!onClick) {
    return <>{children}</>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hint}
      className="rounded-md py-0.5 leading-4 transition-colors outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
    >
      {children}
    </button>
  )
}

export function StatusBar({
  state,
  rateLimits,
  connected,
  connection,
  onOpenStatus,
  onOpenContext,
  onOpenUsage,
  controls,
  actions,
  placement = 'top',
  className,
}: StatusBarProps) {
  const meta = STATUS_META[state.status]
  const now = useNow()
  const windows = rateLimits ?? state.rateLimits
  const session = windows?.five_hour
  const weekly = windows?.seven_day
  const link: ConnectionState = connection ?? (connected === false ? 'reconnecting' : 'live')
  const terminal = useTranscriptVariant() === 'terminal'
  return (
    <div
      data-slot="status-bar"
      className={cn(
        'flex h-[var(--wd-status-bar-height)] items-baseline gap-2 border-border bg-surface p-1.5',
        placement === 'bottom' ? (terminal ? undefined : 'border-t') : 'border-b',
        className,
      )}
    >
      <Slot onClick={onOpenStatus} hint="Session info">
        {link === 'live' ? (
          <Badge variant={meta.variant} dot={!meta.busy} className="items-baseline">
            {meta.busy ? <Spinner className="size-3 self-center text-current" /> : null}
            {meta.label}
          </Badge>
        ) : (
          <Badge variant={link === 'offline' ? 'danger' : 'warning'} dot={false} className="items-baseline">
            {link === 'offline' ? (
              <WifiOff className="size-3 self-center text-current" />
            ) : (
              <RefreshCw className="size-3 animate-spin self-center text-current" />
            )}
            {link === 'offline' ? 'Offline' : 'Reconnecting…'}
          </Badge>
        )}
      </Slot>
      {state.capabilities.contextUsage && state.contextUsage ? (
        <Slot onClick={onOpenContext} hint="Context breakdown">
          <ContextMeter usage={state.contextUsage} />
        </Slot>
      ) : null}
      {session || weekly ? (
        <Slot onClick={onOpenUsage} hint="Plan usage">
          <span className="inline-flex items-baseline gap-2">
            {session ? <RateLimitMeter label="Session" info={session} now={now} /> : null}
            {weekly ? <RateLimitMeter label="Weekly" info={weekly} now={now} /> : null}
          </span>
        </Slot>
      ) : null}
      {controls ? <span className="self-center">{controls}</span> : null}
      <span className="flex-1" />
      <span className="font-mono text-label text-fg-3">{formatCost(state.totalCostUsd)}</span>
      {actions ? <span className="self-center">{actions}</span> : null}
    </div>
  )
}
