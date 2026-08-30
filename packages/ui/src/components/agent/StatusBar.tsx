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
import { STATUS_META } from './status.ts'
import { useTranscriptVariant } from './transcript-variant.tsx'

export interface StatusBarProps {
  state: TranscriptState
  /**
   * Plan windows to draw, when they should not be the session's own — the panel
   * hands over the gateway's per-profile state merged over this transcript's
   * reading (`mergeUsage`), because a session's own `rate_limit` readings arrive
   * only at a turn's edges. Absent = `state.rateLimits`.
   */
  rateLimits?: Record<string, RateLimitInfo>
  /** @deprecated Pass {@link StatusBarProps.connection}; kept so an embedder
   * still handing over a boolean keeps working. */
  connected?: boolean
  /** How the client is doing at reaching the gateway. A dropped socket wins the
   * status slot — session status over a dead socket is a stale reading. */
  connection?: ConnectionState
  /** Where the gauges lead. Omit a handler and that gauge stays a read-only
   * tooltip. */
  onOpenStatus?: () => void
  onOpenContext?: () => void
  onOpenUsage?: () => void
  /** The session's own controls (model, permission mode), for
   * `controlsSurface: 'status'` — at the end of the readings cluster. */
  controls?: ReactNode
  /** Trailing slot — the session-actions menu, at the bar's trailing edge. */
  actions?: ReactNode
  /** Which edge the bar sits on, so its separating rule goes on the other side.
   * Placement is the panel's decision; this only styles it. */
  placement?: 'top' | 'bottom'
  className?: string
}

/** Ticking clock for reset countdowns — rate_limit events are sparse, so tick locally. */
const useNow = (intervalMs = 30_000): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** The CLI reports category colors as its own theme token names ('inactive',
 * 'promptBorder', ...), not CSS colors — only pass through what CSS can render. */
const cssColor = (color: string): string | undefined => (typeof CSS !== 'undefined' && CSS.supports('color', color) ? color : undefined)

const ContextMeter = ({ usage }: { usage: ContextUsage }) => {
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

const RateLimitMeter = ({ label, info, now }: { label: string; info: RateLimitInfo; now: number }) => {
  // The CLI omits utilization on some updates — show the window without a made-up 0%.
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
      {/* Inline, not `inline-flex`: a flex container contributes its FIRST
          item's baseline, which here is the ring's — every reading beside it
          would sit on a different line. */}
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

/** A gauge that leads somewhere. `undefined` handler leaves it inert, so an
 * embedder that mounts no panels doesn't get buttons that do nothing. */
const Slot = ({ onClick, hint, children }: { onClick?: () => void; hint: string; children: ReactNode }) => {
  if (!onClick) {
    return <>{children}</>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hint}
      // No horizontal padding: the bar's own 6px is the inset. `leading-4`
      // matches the label metrics inside — a button's own line box is the
      // page's 24px one, and the strut padded the bar with nothing.
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
        // Baselines, not boxes: the children are boxes of different heights for
        // reasons unrelated to their text, and centring lands their text on
        // four different lines. The height is shared with the docked composer
        // above it (see `Composer.tsx`) so the two strips read as one chrome.
        'flex h-[var(--wd-status-bar-height)] items-baseline gap-2 border-border bg-surface p-1.5',
        // The rule follows the placement — except under the terminal theme at
        // the foot, where the composer above already closes itself with one.
        placement === 'bottom' ? (terminal ? undefined : 'border-t') : 'border-b',
        className,
      )}
    >
      {/* One slot, two meanings: connection trouble wins it. */}
      <Slot onClick={onOpenStatus} hint="Session info">
        {link === 'live' ? (
          // `items-baseline` so the badge answers the row with its label's
          // baseline rather than its pill's box.
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
      {/* Never a 0% meter for an engine that doesn't measure. */}
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
