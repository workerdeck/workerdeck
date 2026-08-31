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

const SEVERITY_TONE: Record<StatusSeverity, Tone> = {
  none: 'dim',
  warning: 'yellow',
  error: 'red',
}

export interface TerminalStatusLineProps {
  className?: string
  state: TranscriptState
  rateLimits?: Record<string, RateLimitInfo>
  connection?: ConnectionState
  onOpenStatus?: () => void
  onOpenContext?: () => void
  onOpenUsage?: () => void
}

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
