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
import { STATUS_META } from './status.ts'
import { useTranscriptVariant } from './transcript-variant.tsx'

export interface StatusBarProps {
  state: TranscriptState
  /** @deprecated Pass {@link StatusBarProps.connection}; kept so an embedder
   * still handing over a boolean keeps working. */
  connected?: boolean
  /** How the client is doing at reaching the gateway. A dropped socket wins the
   * status slot: the session status held over a dead socket is a stale reading,
   * and presenting it as a live one is the thing worth avoiding. */
  connection?: ConnectionState
  /**
   * Where the gauges lead. Each one opens the panel that answers *its* question
   * — the two meters measure different things, so sending both to one "details"
   * list would be a detour every time. Omit a handler and that gauge stays a
   * read-only tooltip.
   */
  onOpenStatus?: () => void
  onOpenContext?: () => void
  onOpenUsage?: () => void
  /**
   * The session's own controls (model, permission mode), for
   * `controlsSurface: 'status'`. They sit at the end of the readings cluster —
   * status, context, usage, then what you can *change* — rather than out by the
   * actions menu, because they belong with the session facts they act on.
   */
  controls?: ReactNode
  /** Trailing slot — the session-actions menu, at the bar's trailing edge. */
  actions?: ReactNode
  /** Which edge the bar sits on, so its separating rule goes on the other side.
   * Placement is the panel's decision; this only styles it. */
  placement?: 'top' | 'bottom'
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
      {/* Inline, not `inline-flex`: a flex container contributes its FIRST
          item's baseline, and the first item here is the ring — so a flex
          version hands the row a 13px circle's baseline instead of the number's,
          and every reading beside it sits on a different line. Inline text has
          only one baseline to give. `align-middle` centres the ring on the
          x-height, which is where it looked right anyway. */}
      <span
        className={cn(
          'cursor-default font-mono text-label whitespace-nowrap',
          info.status === 'rejected' ? 'text-danger' : utilizationColor(pct ?? 0),
        )}>
        <ProgressRing value={pct ?? 0} className='mr-1 inline-block align-middle' />
        {label}
        {pct !== undefined ? ` ${pct.toFixed(0)}%` : ''}
        {resetsAtMs !== undefined ? (
          <span className='text-fg-4'> · {formatCountdown(resetsAtMs, now)}</span>
        ) : null}
      </span>
    </Tip>
  )
}

/** A gauge that leads somewhere. `undefined` handler leaves it inert, so an
 * embedder that mounts no panels doesn't get buttons that do nothing. */
function Slot({ onClick, hint, children }: { onClick?: () => void; hint: string; children: ReactNode }) {
  if (!onClick) return <>{children}</>
  return (
    <button
      type='button'
      onClick={onClick}
      aria-label={hint}
      // `leading-4` matches the label metrics inside: a button's own line box is
      // the page's 24px one, and the extra strut was padding the bar by 2.5px
      // that nothing was using.
      // No horizontal padding: the bar's own 6px is the inset, and a slot that
      // added its own would start the first reading 10px in. The hover surface
      // hugs the text instead, which is what a status line's items do anyway.
      // `leading-4` matches the label metrics inside — a button's own line box
      // is the page's 24px one, and the strut padded the bar with nothing.
      className='rounded-md py-0.5 leading-4 transition-colors outline-none hover:bg-surface-hover focus-visible:bg-surface-hover'>
      {children}
    </button>
  )
}

export function StatusBar({
  state,
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
  const session = state.rateLimits?.five_hour
  const weekly = state.rateLimits?.seven_day
  const link: ConnectionState = connection ?? (connected === false ? 'reconnecting' : 'live')
  const terminal = useTranscriptVariant() === 'terminal'
  return (
    <div
      data-slot='status-bar'
      className={cn(
        // Baselines, not boxes. `items-center` centres each child's *box*, and
        // this bar's children are boxes of different heights for reasons that
        // have nothing to do with their text — a badge's pill padding, a ring
        // beside a number, a select's border and chevron. Centring those lands
        // their text on four slightly different lines. A flex item's baseline is
        // its first line's baseline, so aligning on it puts every reading on one
        // line by construction, whatever is drawn around it.
        // One explicit height, shared with the docked composer above it (see
        // `Composer.tsx`) — the two strips along the foot of the panel read as
        // one piece of chrome, and a pixel of drift between them shows.
        'flex h-[38px] items-baseline gap-2 border-border bg-surface p-1.5',
        // The rule goes between the bar and the content, so which edge it sits
        // on follows the placement — except under the terminal theme at the
        // foot, where the composer directly above already closes itself with a
        // rule of its own. Two adjacent 1px rules is a 2px rule with a seam in
        // it, and it is off the line grid besides.
        placement === 'bottom' ? (terminal ? undefined : 'border-t') : 'border-b',
        className,
      )}>
      {/* One slot, two meanings: connection trouble wins it, because a session
          status shown over a dead socket is a stale reading presented as a live
          one. Tapping it opens the session's own facts — where it runs, on what,
          with which credentials — which is the question a status prompts. */}
      <Slot onClick={onOpenStatus} hint='Session info'>
        {link === 'live' ? (
          // `items-baseline` so the badge answers the row with its label's
          // baseline rather than its pill's box; the dot and the spinner keep
          // their own centring.
          <Badge variant={meta.variant} dot={!meta.busy} className='items-baseline'>
            {meta.busy ? <Spinner className='size-3 self-center text-current' /> : null}
            {meta.label}
          </Badge>
        ) : (
          <Badge
            variant={link === 'offline' ? 'danger' : 'warning'}
            dot={false}
            className='items-baseline'>
            {link === 'offline' ? (
              <WifiOff className='size-3 self-center text-current' />
            ) : (
              <RefreshCw className='size-3 animate-spin self-center text-current' />
            )}
            {link === 'offline' ? 'Offline' : 'Reconnecting…'}
          </Badge>
        )}
      </Slot>
      {/* Never a 0% meter for an engine that doesn't measure: an absent reading
          and a full window are not the same claim. */}
      {state.capabilities.contextUsage && state.contextUsage ? (
        <Slot onClick={onOpenContext} hint='Context breakdown'>
          <ContextMeter usage={state.contextUsage} />
        </Slot>
      ) : null}
      {session || weekly ? (
        <Slot onClick={onOpenUsage} hint='Plan usage'>
          <span className='inline-flex items-baseline gap-2'>
            {session ? <RateLimitMeter label='Session' info={session} now={now} /> : null}
            {weekly ? <RateLimitMeter label='Weekly' info={weekly} now={now} /> : null}
          </span>
        </Slot>
      ) : null}
      {controls}
      <span className='flex-1' />
      <span className='font-mono text-label text-fg-3'>{formatCost(state.totalCostUsd)}</span>
      {actions}
    </div>
  )
}
