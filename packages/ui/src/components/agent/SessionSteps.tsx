import { ArrowRight, Check, CircleAlert } from 'lucide-react'
import { isAgentRecord, promotedShells, subagentLabel, visibleSubagents } from '@workerdeck/protocol'
import type { SessionInfo, ShellInfo, SubagentDisplay, SubagentInfo } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import {
  SHELL_AGENT_WRITE_GLYPH,
  SHELL_AGENT_WRITE_NOTE,
  SHELL_GLYPH,
  SHELL_KILL_GLYPH,
  shellAgentWriteLabel,
  shellGrantable,
  shellInfoFailed,
  shellInfoLabel,
  shellInfoStatusText,
  shellTitle,
} from '../terminal/shell-row.ts'

export type StepKind = 'agent' | 'shell'

export type Step = {
  key: string
  kind: StepKind
  label: string
  noun: string
  state: 'done' | 'running' | 'failed'
  detail?: string
  title: string
  onSelect: () => void
  onKill?: () => void
  agentWrite?: { granted: boolean; label: string; toggle: () => void }
}

export type ShellStepOptions = {
  now: number
  onSelect: (shellId: string) => void
  onKill?: (shellId: string) => void
  // Offered only where the session's agent holds the shell write tools.
  onAgentWrite?: (shellId: string, enabled: boolean) => void
}

export function sessionSteps(
  info: SessionInfo,
  onSelect: (toolUseId: string) => void,
  show: SubagentDisplay = 'all',
  shells?: ShellStepOptions,
): Step[] {
  const agents: Step[] = visibleSubagents(info, show)
    .filter(isAgentRecord)
    .map((sub) => ({
      key: sub.toolUseId,
      kind: 'agent',
      label: subagentLabel(sub),
      noun: 'agent',
      state: stepState(sub.status),
      detail: sub.toolCount > 0 ? String(sub.toolCount) : undefined,
      title: `${subagentLabel(sub)} · ${sub.toolCount} tool${sub.toolCount === 1 ? '' : 's'}`,
      onSelect: () => onSelect(sub.toolUseId),
    }))
  if (shells === undefined) {
    return agents
  }
  const grants = info.shellAgentWrite !== undefined
  return [...agents, ...promotedShells(info, shells.now).map((shell) => shellStep(shell, shells, grants))]
}

function shellStep(shell: ShellInfo, options: ShellStepOptions, grants: boolean): Step {
  const status = shellInfoStatusText(shell)
  const running = shell.status === 'running'
  return {
    key: shell.id,
    kind: 'shell',
    label: shellInfoLabel(shell),
    noun: 'shell',
    state: shellInfoFailed(shell) ? 'failed' : running ? 'running' : 'done',
    detail: running ? (shell.agentWrite === true ? SHELL_AGENT_WRITE_NOTE : undefined) : status,
    title: `${shellTitle(shell)} · ${status}`,
    onSelect: () => options.onSelect(shell.id),
    onKill: running && options.onKill ? () => options.onKill?.(shell.id) : undefined,
    agentWrite:
      grants && options.onAgentWrite && shellGrantable(shell)
        ? {
            granted: shell.agentWrite === true,
            label: shellAgentWriteLabel(shell),
            toggle: () => options.onAgentWrite?.(shell.id, shell.agentWrite !== true),
          }
        : undefined,
  }
}

function stepState(status: SubagentInfo['status']): Step['state'] {
  switch (status) {
    case 'running': {
      return 'running'
    }
    case 'failed': {
      return 'failed'
    }
    default: {
      return 'done'
    }
  }
}

export function StepRow({ step, active = false, onSelect }: { step: Step; active?: boolean; onSelect: () => void }) {
  const body = step.state === 'failed' ? 'text-danger' : step.kind === 'shell' ? 'text-[var(--wd-shell-accent)]' : 'text-success'
  return (
    <div className={cn('flex w-full items-center rounded-[4px] pr-1.5', active ? 'bg-row-selected' : 'hover:bg-row-active', body)}>
      <button
        type="button"
        title={step.title}
        aria-current={active || undefined}
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 pl-3.5 text-left text-micro outline-none"
      >
        <StepIcon step={step} />
        <span className="min-w-0 flex-1 truncate">{step.label}</span>
        {step.detail ? <span className="shrink-0 tabular-nums text-fg-4">{step.detail}</span> : null}
        <ArrowRight className="size-3.5 shrink-0 text-fg-4" />
      </button>
      {step.agentWrite ? (
        <button
          type="button"
          aria-label={step.agentWrite.label}
          aria-pressed={step.agentWrite.granted}
          title={step.agentWrite.label}
          onClick={(e) => {
            e.stopPropagation()
            step.agentWrite?.toggle()
          }}
          className={cn(
            'shrink-0 px-1 text-micro leading-none outline-none',
            step.agentWrite.granted ? 'text-warning' : 'text-fg-4 hover:text-fg-1',
          )}
        >
          {SHELL_AGENT_WRITE_GLYPH}
        </button>
      ) : null}
      {step.onKill ? (
        <button
          type="button"
          aria-label={`Kill ${step.label}`}
          title="Kill this shell"
          onClick={(e) => {
            e.stopPropagation()
            step.onKill?.()
          }}
          className="shrink-0 px-1 text-micro leading-none text-fg-4 outline-none hover:text-danger"
        >
          {SHELL_KILL_GLYPH}
        </button>
      ) : null}
    </div>
  )
}

function StepIcon({ step }: { step: Step }) {
  if (step.kind === 'shell') {
    return <span className="w-[11px] shrink-0 text-center leading-none">{SHELL_GLYPH}</span>
  }
  switch (step.state) {
    case 'running': {
      return <Spinner className="size-[11px] shrink-0" />
    }
    case 'failed': {
      return <CircleAlert className="size-[11px] shrink-0" />
    }
    default: {
      return <Check className="size-[11px] shrink-0" />
    }
  }
}
