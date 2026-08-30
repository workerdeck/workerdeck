import type { RateLimitInfo } from '@workerdeck/protocol'
import type { ConnectionState, TranscriptState } from '@workerdeck/react'
import { formatCost, formatTokens } from '../../lib/format.ts'
import {
  contextSeverity,
  meterSeverity,
  modelLabel,
  statusPresentation,
  tightestWindow,
  windowLabel,
  type StatusSeverity,
} from '../../lib/status.ts'
import { Ink, Row, type Tone } from './row.tsx'

/**
 * The session's readings, as one line.
 *
 * The styled bar puts each of these in its own affordance — a progress ring, a
 * badge, a tooltip — which is right for a dashboard and wrong here for the usual
 * reason: a terminal has one line height, and five widgets of five different
 * heights is five different rhythms in a row that is supposed to be quiet. So
 * they are words, `·`-separated, exactly as the CLI's own status line writes
 * them.
 *
 * The readings themselves come from the same helpers the styled bar uses
 * (`lib/status.ts`), and that matters more than it looks: `statusPresentation`
 * is where the rule lives that **a dropped socket outranks the session status**,
 * because a status held over a dead socket is a stale reading being presented as
 * a live one. Re-deriving that here would be a second answer to a question that
 * already has one.
 */

/** Severity → tone. The 80/95 thresholds are `lib/status.ts`'s, not new ones. */
const SEVERITY_TONE: Record<StatusSeverity, Tone> = {
  none: 'dim',
  warning: 'yellow',
  error: 'red',
}

export interface TerminalStatusLineProps {
  className?: string
  state: TranscriptState
  /** Plan windows to read from, when they should not be the session's own — the
   * gateway's per-profile state merged over this transcript's. See
   * {@link StatusBarProps.rateLimits}. Absent = `state.rateLimits`. */
  rateLimits?: Record<string, RateLimitInfo>
  /** How the client is doing at reaching the gateway. Wins the status slot when
   * the socket is down — see above. */
  connection?: ConnectionState
  /** Opens the panel that answers each reading's own question. Omit and the
   * reading is text rather than something to press. */
  onOpenStatus?: () => void
  onOpenContext?: () => void
  onOpenUsage?: () => void
}

/** One reading. A button only when it leads somewhere — a segment that looks
 * pressable and does nothing is worse than plain text. */
function Reading({ tone, onPress, label, children }: { tone?: Tone; onPress?: () => void; label?: string; children: React.ReactNode }) {
  if (!onPress) {
    return <Ink tone={tone}>{children}</Ink>
  }
  return (
    <button type="button" className="term-reading" onClick={onPress} title={label}>
      <Ink tone={tone}>{children}</Ink>
    </button>
  )
}

export function TerminalStatusLine({
  className,
  state,
  rateLimits,
  connection,
  onOpenStatus,
  onOpenContext,
  onOpenUsage,
}: TerminalStatusLineProps) {
  const presentation = statusPresentation({ status: state.status, connection })
  const usage = state.contextUsage
  const window = tightestWindow(rateLimits ?? state.rateLimits)
  const model = modelLabel({ model: state.model, models: state.models ?? [] })

  const parts: React.ReactNode[] = [
    <Reading key="status" tone={SEVERITY_TONE[presentation.severity]} onPress={onOpenStatus} label="Session status">
      {presentation.label}
    </Reading>,
  ]

  if (usage) {
    parts.push(
      <Reading key="context" tone={SEVERITY_TONE[contextSeverity(usage)]} onPress={onOpenContext} label="Context window">
        {Math.round(usage.percentage)}% ctx ({formatTokens(usage.totalTokens)})
      </Reading>,
    )
  }

  if (window) {
    parts.push(
      <Reading key="usage" tone={SEVERITY_TONE[meterSeverity(window.info.utilization)]} onPress={onOpenUsage} label="Plan usage">
        {Math.round(window.info.utilization ?? 0)}% {windowLabel(window.key)}
      </Reading>,
    )
  }

  // Cost last of the numbers: it is the reading you check, never the one you act
  // on, and nothing about a turn changes because of it.
  if (state.totalCostUsd > 0) {
    parts.push(
      <Ink key="cost" tone="faint">
        {formatCost(state.totalCostUsd)}
      </Ink>,
    )
  }

  if (model) {
    parts.push(
      <Ink key="model" tone="faint">
        {model}
      </Ink>,
    )
  }
  if (state.permissionMode && state.permissionMode !== 'default') {
    parts.push(
      <Ink key="mode" tone="yellow">
        {state.permissionMode}
      </Ink>,
    )
  }

  return (
    <Row data-slot="status-line" tone="dim" className={className}>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? <Ink tone="faint"> · </Ink> : null}
          {part}
        </span>
      ))}
    </Row>
  )
}
