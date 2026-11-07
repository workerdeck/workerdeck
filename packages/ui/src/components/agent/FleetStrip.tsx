import { ATTENTION_LABELS, attentionTitle, type FleetRow, type SessionRow } from '@workerdeck/protocol'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Ink, Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'

export interface FleetStripProps {
  fleet: readonly FleetRow[]
  peerRows?: Readonly<Record<string, SessionRow>>
  onOpen?: (sessionId: string) => void
  onRetry?: (row: FleetRow) => Promise<void>
  terminal: boolean
  fontSize?: number
  lineHeight?: number
}

export function FleetStrip({ fleet, peerRows, onOpen, onRetry, terminal, fontSize, lineHeight }: FleetStripProps) {
  const [retrying, setRetrying] = useState<string>()
  if (fleet.length === 0) {
    return null
  }
  const retry = (row: FleetRow) => {
    if (!onRetry || retrying !== undefined) {
      return
    }
    setRetrying(row.key)
    void onRetry(row).finally(() => setRetrying(undefined))
  }
  const name = (row: FleetRow, className?: string) =>
    onOpen ? (
      <button type="button" onClick={() => onOpen(row.id)} title={`Open ${row.name}`} className={cn('cursor-pointer text-left hover:underline', className)}>
        {row.name}
      </button>
    ) : (
      <span className={className}>{row.name}</span>
    )
  const chipTitle = (row: FleetRow, reason: FleetRow['reasons'][number]) => {
    const info = peerRows?.[row.id]?.info
    return info ? attentionTitle(reason, info) : ATTENTION_LABELS[reason]
  }

  if (terminal) {
    return (
      <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} className="shrink-0" aria-label="Members that need you">
        {fleet.map((row) => {
          const failed = row.reasons[0] === 'failed'
          return (
            <Row key={row.key} glyph="!" glyphTone={failed ? 'red' : 'yellow'} indent={1}>
              {name(row)}
              {row.reasons.map((reason) => (
                <Ink key={reason} tone={reason === 'failed' ? 'red' : 'yellow'} title={chipTitle(row, reason)}>
                  {' '}
                  {ATTENTION_LABELS[reason].toLowerCase()}
                </Ink>
              ))}
              <Ink tone="faint"> · {row.text}</Ink>
              {onRetry && row.retry !== undefined ? (
                <button type="button" onClick={() => retry(row)} disabled={retrying !== undefined} className="cursor-pointer">
                  <Ink tone="mark"> [{retrying === row.key ? 'retrying…' : 'retry'}]</Ink>
                </button>
              ) : null}
            </Row>
          )
        })}
      </TerminalSurface>
    )
  }

  return (
    <div className="flex shrink-0 flex-col border-b border-border px-3 py-1" aria-label="Members that need you">
      {fleet.map((row) => {
        const peer = peerRows?.[row.id]
        return (
          <div key={row.key} className="flex min-w-0 items-center gap-2 py-0.5">
            {peer ? <AgentAvatar row={peer} size={16} badge={false} /> : null}
            {name(row, 'shrink-0 text-body-sm text-fg-2')}
            {row.reasons.map((reason) => (
              <span
                key={reason}
                title={chipTitle(row, reason)}
                className={cn(
                  'flex h-4 shrink-0 items-center rounded-[3px] px-1 text-micro leading-none',
                  reason === 'failed' ? 'bg-danger-bg text-danger' : 'bg-warning-bg text-warning',
                )}
              >
                {ATTENTION_LABELS[reason]}
              </span>
            ))}
            <span className="min-w-0 flex-1 truncate text-label text-fg-3" title={row.text}>
              {row.text}
            </span>
            {onRetry && row.retry !== undefined ? (
              <Button variant="ghost" size="sm" onClick={() => retry(row)} disabled={retrying !== undefined} className="h-5 gap-1 px-1.5">
                <RotateCcw className="size-3" />
                {retrying === row.key ? 'Retrying…' : 'Retry'}
              </Button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
