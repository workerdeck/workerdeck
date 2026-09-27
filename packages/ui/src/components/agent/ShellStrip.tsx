import { X } from 'lucide-react'
import type { ShellInfo } from '@workerdeck/protocol'
import { cn } from '../../lib/utils.ts'
import { shellAgentWriteLabel, shellGrantable, shellInfoFailed, shellInfoStatusText, shellTitle } from '../terminal/shell-row.ts'
import { AgentWriteAction, AgentWriteIcon, KillShellAction } from '../terminal/affordances.tsx'
import { FrameStrip } from './FrameStrip.tsx'

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

  const actions = terminal ? (
    <>
      {grant && shell ? <AgentWriteAction granted={granted} label={shellAgentWriteLabel(shell)} onToggle={grant} /> : null}
      {running && onKill ? <KillShellAction onKill={onKill} /> : null}
    </>
  ) : (
    <>
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
    </>
  )

  return (
    <FrameStrip
      kind="shell"
      name={name}
      status={status}
      detail={detail}
      failed={failed}
      live={running}
      onBack={onBack}
      actions={actions}
      terminal={terminal}
      fontSize={fontSize}
      lineHeight={lineHeight}
    />
  )
}
