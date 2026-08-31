import { ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Dot, PauseCircle } from 'lucide-react'
import { isAgentRecord, subagentLabel } from '@workerdeck/protocol'
import type { SessionInfo, SubagentInfo } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

export type Step = {
  key: string
  label: string
  noun: string
  kind: 'agent' | 'task'
  state: 'done' | 'running' | 'pending' | 'failed'
  detail?: string
  title: string
  onSelect: () => void
}

export function sessionSteps(info: SessionInfo, onSelect: (toolUseId: string, kind: Step['kind']) => void): Step[] {
  const steps = (info.subagents ?? []).map((sub) => {
    const kind = isAgentRecord(sub) ? ('agent' as const) : ('task' as const)
    return {
      key: sub.toolUseId,
      label: subagentLabel(sub),
      noun: 'agent',
      kind,
      state: stepState(sub.status),
      detail: sub.toolCount > 0 ? String(sub.toolCount) : undefined,
      title: `${subagentLabel(sub)} · ${sub.toolCount} tool${sub.toolCount === 1 ? '' : 's'}`,
      onSelect: () => onSelect(sub.toolUseId, kind),
    }
  })
  return [...steps.filter((s) => s.kind === 'agent'), ...steps.filter((s) => s.kind === 'task')]
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

export function runningSteps(steps: readonly Step[]): number {
  return steps.filter((s) => s.state === 'running').length
}

export function StepToggle({
  expanded,
  running,
  total,
  noun,
  onToggle,
}: {
  expanded: boolean
  running: number
  total: number
  noun: string
  onToggle: () => void
}) {
  const label = running > 0 && running < total ? `${running}/${total}` : String(total)
  const words = running > 0 && running < total ? `${running} of ${total} ${noun}s running` : `${total} ${noun}${total === 1 ? '' : 's'}`
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} ${words}`}
      title={`${expanded ? 'Hide' : 'Show'} ${words}`}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'flex shrink-0 items-center gap-0.5 rounded-[4px] py-0.5 pr-1 pl-0.5 outline-none',
        'text-[0.75rem] leading-3 hover:bg-row-hover hover:text-fg-2',
        running > 0 ? 'text-info' : 'text-fg-4',
      )}
    >
      <Chevron className="size-3" />
      <span className="tabular-nums">{label}</span>
    </button>
  )
}

export function StepRow({ step, active = false, onSelect }: { step: Step; active?: boolean; onSelect: () => void }) {
  const agent = step.kind === 'agent'
  const selected = active && agent
  const body = step.state === 'failed' ? 'text-danger' : agent ? 'text-success' : 'text-fg-4'
  return (
    <button
      type="button"
      title={step.title}
      aria-current={selected || undefined}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-[4px] py-1 pr-2.5 pl-3.5',
        'text-left text-micro outline-none',
        selected ? 'bg-row-selected' : 'hover:bg-row-active',
        body,
      )}
    >
      <StepIcon state={step.state} kind={step.kind} />
      <span className="min-w-0 flex-1 truncate">{step.label}</span>
      {step.detail ? <span className="shrink-0 tabular-nums text-fg-4">{step.detail}</span> : null}
      {agent ? <ArrowRight className="size-3.5 shrink-0 text-fg-4" /> : null}
    </button>
  )
}

function StepIcon({ state, kind }: { state: Step['state']; kind: Step['kind'] }) {
  if (kind === 'task' && state !== 'running' && state !== 'failed') {
    return <Dot className="size-[11px] shrink-0" />
  }
  switch (state) {
    case 'running': {
      return <Spinner className="size-[11px] shrink-0" />
    }
    case 'failed': {
      return <CircleAlert className="size-[11px] shrink-0" />
    }
    case 'pending': {
      return <PauseCircle className="size-[11px] shrink-0" />
    }
    default: {
      return <Check className="size-[11px] shrink-0" />
    }
  }
}
