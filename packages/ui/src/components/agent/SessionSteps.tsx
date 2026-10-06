import { ArrowRight, Check, Circle, CircleAlert } from 'lucide-react'
import { displayedTasks, isAgentRecord, subagentLabel, visibleShells, visibleSubagents } from '@workerdeck/protocol'
import type { SessionInfo, SessionTask, ShellInfo, StepDisplay, SubagentDisplay, SubagentInfo } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { AgentWriteIcon } from '../terminal/affordances.tsx'
import {
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

export type StepKind = 'agent' | 'shell' | 'task'

export type Step = {
  key: string
  kind: StepKind
  label: string
  noun: string
  state: 'done' | 'running' | 'failed' | 'pending'
  detail?: string
  title: string
  onSelect: () => void
  onKill?: () => void
  killLabel?: string
  agentWrite?: { granted: boolean; label: string; toggle: () => void }
}

export type ShellStepOptions = {
  now: number
  show?: StepDisplay
  onSelect: (shellId: string) => void
  onKill?: (shellId: string) => void
  // Offered only where the session's agent holds the shell write tools.
  onAgentWrite?: (shellId: string, enabled: boolean) => void
}

export type TaskStepOptions = {
  show: StepDisplay
  // Whether the session is still working: a checklist item left in progress after the turn ended is not running.
  live: boolean
  onSelect: (task: SessionTask) => void
  onStop?: (toolUseId: string) => void
}

export function sessionSteps(
  info: SessionInfo,
  onSelect: (toolUseId: string) => void,
  show: SubagentDisplay = 'all',
  shells?: ShellStepOptions,
  tasks?: TaskStepOptions,
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
  const taskSteps = tasks === undefined ? [] : displayedTasks(info, tasks.show).map((task) => taskStep(task, tasks))
  if (shells === undefined) {
    return [...agents, ...taskSteps]
  }
  const grants = info.shellAgentWrite !== undefined
  const shellSteps = visibleShells(info, shells.show ?? 'active', shells.now).map((shell) => shellStep(shell, shells, grants))
  return [...agents, ...taskSteps, ...shellSteps]
}

function taskStep(task: SessionTask, options: TaskStepOptions): Step {
  const stalled = task.source === 'checklist' && task.state === 'running' && !options.live
  const toolUseId = task.toolUseId
  return {
    key: task.key,
    kind: 'task',
    label: task.label,
    noun: 'task',
    state: stalled ? 'pending' : task.state,
    detail: task.detail,
    title: stalled ? `${task.label} · left in progress` : task.label,
    onSelect: () => options.onSelect(task),
    onKill: task.stoppable && toolUseId !== undefined && options.onStop ? () => options.onStop?.(toolUseId) : undefined,
    killLabel: 'Stop this task',
  }
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
    killLabel: 'Kill this shell',
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
  const body =
    step.state === 'failed'
      ? 'text-danger'
      : step.kind === 'shell'
        ? 'text-[var(--wd-shell-accent)]'
        : step.kind === 'task'
          ? step.state === 'pending'
            ? 'text-fg-4'
            : 'text-fg-2'
          : 'text-success'
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
        <span className={cn('min-w-0 flex-1 truncate', step.kind === 'shell' && 'font-mono')}>{step.label}</span>
        {step.detail ? <span className="shrink-0 tabular-nums text-fg-4">{step.detail}</span> : null}
        {step.kind === 'agent' ? <ArrowRight className="size-3.5 shrink-0 text-fg-4" /> : null}
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
          <AgentWriteIcon granted={step.agentWrite.granted} className="size-3.5" />
        </button>
      ) : null}
      {step.onKill ? (
        <button
          type="button"
          aria-label={`${step.kind === 'task' ? 'Stop' : 'Kill'} ${step.label}`}
          title={step.killLabel}
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
    case 'pending': {
      return <Circle className="size-[11px] shrink-0" />
    }
    default: {
      return <Check className="size-[11px] shrink-0" />
    }
  }
}
