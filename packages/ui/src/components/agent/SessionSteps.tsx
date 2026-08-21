import { ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, PauseCircle } from 'lucide-react'
import { subagentLabel } from '@workerdeck/protocol'
import type { SessionInfo, SubagentInfo } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

/**
 * The work *under* a session row, and the one row shape every client renders it
 * through.
 *
 * This lived inside the VS Code webview first, which is exactly why the
 * dashboard had none of it. Nothing in here is extension-specific: a session's
 * sub-agents are a protocol fact, and a disclosure over them is a list
 * affordance. It sits in `packages/ui` so the sidebar, the dashboard and (in its
 * own idiom) the phone are annotating rows the same way rather than three ways.
 *
 * Today the only source is `SessionInfo.subagents`. The other — the CLI's own
 * **task checklist**, the to-do list it keeps for the current turn — is what the
 * design was drawn from, and it is not built: nothing on the wire carries it yet
 * (see `_docs/features/sub-agent-handling.md`, second thread, which opens with
 * "check a capture" rather than "design a surface"). When it arrives it is a
 * *source*, not a second row component: checklist when the session has one, its
 * sub-agents otherwise.
 *
 * That is also why `state` has a `pending` arm no sub-agent can produce. A
 * sub-agent record exists only once dispatched, so it is never queued; a to-do
 * is queued for most of its life, and dropping the state would mean widening the
 * union later — the shape is cheaper to state now than to retrofit.
 */
export type Step = {
  key: string
  label: string
  /** What one of these is called, for the disclosure's count. */
  noun: string
  state: 'done' | 'running' | 'pending' | 'failed'
  /** A trailing reading — a sub-agent's tool count. Absent draws nothing. */
  detail?: string
  title: string
  onSelect: () => void
}

export function sessionSteps(
  info: SessionInfo,
  onSelectSubagent: (toolUseId: string) => void,
): Step[] {
  // The label is protocol's `subagentLabel`, not a spelling of its own: the
  // dashboard and the phone render the same rows from the same records, and two
  // spellings would be two different answers to "which agent is this".
  return (info.subagents ?? []).map((sub) => ({
    key: sub.toolUseId,
    label: subagentLabel(sub),
    noun: 'agent',
    state: stepState(sub.status),
    detail: sub.toolCount > 0 ? String(sub.toolCount) : undefined,
    title: `${subagentLabel(sub)} · ${sub.toolCount} tool${sub.toolCount === 1 ? '' : 's'}`,
    onSelect: () => onSelectSubagent(sub.toolUseId),
  }))
}

function stepState(status: SubagentInfo['status']): Step['state'] {
  switch (status) {
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    default:
      return 'done'
  }
}

/** How many of these are still going — the live half of the disclosure's count. */
export function runningSteps(steps: readonly Step[]): number {
  return steps.filter((s) => s.state === 'running').length
}

/**
 * The disclosure, which is also the reading: `3 agents` — or `2 of 3 agents`
 * while some have settled, because "how many are still going" is the live
 * question and a bare total answers it wrong the moment one finishes.
 *
 * Sub-agents are an annotation on a working row rather than a state of their own
 * (see `runningSubagents` in protocol's `session-list.ts`), so this never
 * competes with the row's status glyph: that still says what the *session* is
 * doing.
 */
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
  // Two spellings of one count. The **words** are the honest reading and go in
  // the tooltip and to a screen reader; the line itself gets the digits, because
  // this sits on the second line of a 280px row next to the folder and the age,
  // and `1 of 6 agents` truncated the folder name away to say something the row
  // could say in three characters.
  const label = running > 0 && running < total ? `${running}/${total}` : String(total)
  const words =
    running > 0 && running < total
      ? `${running} of ${total} ${noun}s running`
      : `${total} ${noun}${total === 1 ? '' : 's'}`
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <button
      type='button'
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} ${words}`}
      title={`${expanded ? 'Hide' : 'Show'} ${words}`}
      onClick={(e) => {
        // The whole row is a button and this one does not mean "select" — the
        // same guard the row's overflow needs, and the reason a drag-select
        // inside the row does not toggle it.
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'flex shrink-0 items-center gap-0.5 rounded px-0.5 outline-none',
        'hover:bg-surface-hover hover:text-fg-2',
        running > 0 ? 'text-info' : 'text-fg-4',
      )}>
      <Chevron className='size-3' />
      <span className='tabular-nums'>{label}</span>
    </button>
  )
}

/**
 * One step under its session. Pressing it opens the session *at* that `Task`'s
 * row — a sub-agent is not a session and has no screen of its own, so that is
 * the only honest meaning of opening one.
 *
 * Divided from the row's header and from each other by a rule rather than by
 * indentation: these are a list *inside* the row, and at 11px an indent is not
 * enough to say so. The rule is black at 25% so it darkens whatever the row is
 * filled with, selected or not, without needing a colour per state.
 */
export function StepRow({ step, onSelect }: { step: Step; onSelect: () => void }) {
  return (
    <button
      type='button'
      title={step.title}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-2 border-t border-black/25 py-1 pl-3 pr-2 text-left text-label outline-none',
        'hover:bg-surface-hover',
        step.state === 'running'
          ? 'text-info'
          : step.state === 'failed'
            ? 'text-danger'
            : step.state === 'pending'
              ? 'text-fg-4'
              : 'text-fg-2',
      )}>
      <StepIcon state={step.state} />
      <span className='min-w-0 flex-1 truncate'>{step.label}</span>
      {/* The progress reading while it works, and what it cost when it is done.
          Zero draws nothing: `0 tools` beside a thinking agent reads as a stall,
          which is the same call `taskSummary` makes one surface over. */}
      {step.detail ? <span className='shrink-0 tabular-nums text-fg-4'>{step.detail}</span> : null}
      <ArrowRight className='size-3 shrink-0 opacity-60' />
    </button>
  )
}

function StepIcon({ state }: { state: Step['state'] }) {
  switch (state) {
    case 'running':
      return <Spinner className='size-3 shrink-0' />
    case 'failed':
      return <CircleAlert className='size-3 shrink-0' />
    case 'pending':
      return <PauseCircle className='size-3 shrink-0' />
    default:
      return <Check className='size-3 shrink-0' />
  }
}
