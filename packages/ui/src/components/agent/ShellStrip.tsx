import { ArrowLeft, X } from 'lucide-react'
import type { ShellInfo } from '@workerdeck/protocol'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Ink, Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { shellAgentWriteLabel, shellGrantable, shellInfoFailed, shellInfoStatusText, shellTitle } from '../terminal/shell-row.ts'
import { AgentWriteAction, AgentWriteIcon, KillShellAction, WithActions } from '../terminal/affordances.tsx'

export interface ShellStripProps {
  shell: ShellInfo | undefined
  label: string
  cols?: number
  onBack: () => void
  onKill?: () => void
  onAgentWrite?: (enabled: boolean) => void
  terminal: boolean
  fontSize?: number
  lineHeight?: number
}

export function ShellStrip({ shell, label, cols, onBack, onKill, onAgentWrite, terminal, fontSize, lineHeight }: ShellStripProps) {
  const running = shell?.status === 'running'
  const failed = shell ? shellInfoFailed(shell) : false
  const name = shell ? shellTitle(shell) : label
  const status = shell ? shellInfoStatusText(shell) : undefined
  const width = cols ?? shell?.cols
  const detail = width === undefined ? undefined : `${width} cols`
  const granted = shell?.agentWrite === true
  const grant = shell && onAgentWrite && shellGrantable(shell) ? () => onAgentWrite(!granted) : undefined

  if (terminal) {
    return (
      <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} className="shrink-0">
        <WithActions
          placement="inline"
          actions={
            <>
              {grant && shell ? <AgentWriteAction granted={granted} label={shellAgentWriteLabel(shell)} onToggle={grant} /> : null}
              {running && onKill ? <KillShellAction onKill={onKill} /> : null}
            </>
          }
        >
          <Row glyph="←" glyphTone="dim" indent={1} tone={failed ? 'red' : 'magenta'}>
            <button type="button" onClick={onBack} aria-label="Back to the session" className="cursor-pointer text-left">
              {name}
            </button>
            {status ? <Ink tone={failed ? 'red' : running ? 'magenta' : 'dim'}> · {status}</Ink> : null}
            {detail ? <Ink tone="faint"> · {detail}</Ink> : null}
          </Row>
        </WithActions>
      </TerminalSurface>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Button variant="ghost" size="sm" onClick={onBack} className="h-6 gap-1 px-1.5">
        <ArrowLeft className="size-3.5" />
        Back
      </Button>
      <span className={cn('min-w-0 flex-1 truncate font-mono text-body-sm', failed ? 'text-danger' : 'text-fg-2')}>{name}</span>
      {status ? (
        <span className={cn('shrink-0 text-label', failed ? 'text-danger' : running ? 'text-[var(--wd-shell-accent)]' : 'text-fg-3')}>
          {status}
        </span>
      ) : null}
      {detail ? <span className="shrink-0 text-label text-fg-4">{detail}</span> : null}
      {grant && shell ? (
        <button
          type="button"
          aria-label={shellAgentWriteLabel(shell)}
          aria-pressed={granted}
          title={shellAgentWriteLabel(shell)}
          className={cn('shrink-0 text-label', granted ? 'text-warning' : 'text-fg-3 hover:text-fg-1')}
          onClick={grant}
        >
          <AgentWriteIcon granted={granted} className="size-3.5" />
        </button>
      ) : null}
      {running && onKill ? (
        <button
          type="button"
          aria-label="Kill this shell"
          title="Kill this shell"
          className="shrink-0 text-label text-fg-3 hover:text-danger"
          onClick={onKill}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
