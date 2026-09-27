import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Ink, Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { WithActions } from '../terminal/affordances.tsx'

export type FrameKind = 'shell' | 'subagent'

export interface FrameStripProps {
  kind: FrameKind
  name: string
  status?: string
  detail?: string
  failed: boolean
  live: boolean
  onBack: () => void
  // Drawn at the strip's trailing edge; a terminal strip then hangs them inline, which is why only the name stays the Back target.
  actions?: ReactNode
  terminal: boolean
  fontSize?: number
  lineHeight?: number
}

const TERMINAL_TONE = { shell: { name: 'magenta', live: 'magenta' }, subagent: { name: 'green', live: 'mark' } } as const
const CARDS_LIVE_CLASS: Record<FrameKind, string> = { shell: 'text-[var(--wd-shell-accent)]', subagent: 'text-accent' }

export function FrameStrip({ kind, name, status, detail, failed, live, onBack, actions, terminal, fontSize, lineHeight }: FrameStripProps) {
  if (terminal) {
    const tones = TERMINAL_TONE[kind]
    const line = (label: ReactNode) => (
      <Row glyph="←" glyphTone="dim" indent={1} tone={failed ? 'red' : tones.name}>
        {label}
        {status ? <Ink tone={failed ? 'red' : live ? tones.live : 'dim'}> · {status}</Ink> : null}
        {detail ? <Ink tone="faint"> · {detail}</Ink> : null}
      </Row>
    )
    return (
      <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} className="shrink-0">
        {actions === undefined ? (
          <button type="button" onClick={onBack} aria-label="Back to the session" className="block w-full cursor-pointer text-left">
            {line(name)}
          </button>
        ) : (
          <WithActions placement="inline" actions={actions}>
            {line(
              <button type="button" onClick={onBack} aria-label="Back to the session" className="cursor-pointer text-left">
                {name}
              </button>,
            )}
          </WithActions>
        )}
      </TerminalSurface>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Button variant="ghost" size="sm" onClick={onBack} className="h-6 gap-1 px-1.5">
        <ArrowLeft className="size-3.5" />
        Back
      </Button>
      <span className={cn('min-w-0 flex-1 truncate text-body-sm', kind === 'shell' && 'font-mono', failed ? 'text-danger' : 'text-fg-2')}>
        {name}
      </span>
      {status ? (
        <span className={cn('shrink-0 text-label', failed ? 'text-danger' : live ? CARDS_LIVE_CLASS[kind] : 'text-fg-3')}>{status}</span>
      ) : null}
      {detail ? <span className="shrink-0 text-label text-fg-4">{detail}</span> : null}
      {actions}
    </div>
  )
}
