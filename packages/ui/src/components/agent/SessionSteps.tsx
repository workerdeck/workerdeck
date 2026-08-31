import { ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Dot, PauseCircle } from 'lucide-react'
import { isAgentRecord, subagentLabel } from '@workerdeck/protocol'
import type { SessionInfo, SubagentInfo } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

/**
 * The work *under* a session row, and the one row shape every client renders it
 * through.
 *
 * Today the only source is `SessionInfo.subagents`; the CLI's task checklist is
 * meant to slot in as a second *source*, not a second row component. That is why
 * `state` has a `pending` arm no sub-agent can produce — a sub-agent record
 * exists only once dispatched, so it is never queued.
 */
export type Step = {
  key: string
  label: string
  /** What one of these is called, for the disclosure's count. */
  noun: string
  /**
   * Both kinds press; the kind decides **where the press goes**. An **agent**
   * opens its own frame. A **task** has no agent behind it (`isAgentRecord`) and
   * so no frame — framing its id selects no items and draws an empty screen — so
   * it travels to the spawning call's row instead.
   */
  kind: 'agent' | 'task'
  state: 'done' | 'running' | 'pending' | 'failed'
  /** A trailing reading — a sub-agent's tool count. Absent draws nothing. */
  detail?: string
  title: string
  onSelect: () => void
}

/**
 * The steps under one session, **agents first**. The sort partitions and never
 * reorders inside a partition: dispatch order is the only order these records
 * have that means anything.
 *
 * `onSelect` is handed the **kind** as well as the id, because the two kinds go
 * to different places — a framed task id matches no items, so passing only the
 * id drew an empty agent view.
 */
export const sessionSteps = (info: SessionInfo, onSelect: (toolUseId: string, kind: Step['kind']) => void): Step[] => {
  // protocol's `subagentLabel`, never a spelling of its own — every client
  // renders these records, and two spellings are two answers.
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

const stepState = (status: SubagentInfo['status']): Step['state'] => {
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

/** How many of these are still going — the live half of the disclosure's count. */
export const runningSteps = (steps: readonly Step[]): number => steps.filter((s) => s.state === 'running').length

/**
 * The disclosure, which is also the reading: `3 agents`, or `2 of 3` while some
 * have settled. Sub-agents are an annotation on a working row rather than a
 * state of their own, so this never competes with the row's status glyph.
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
  // Two spellings of one count: the words for the tooltip and screen readers,
  // the digits for the line, which shares a 280px row with the folder and age.
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
        // The whole row is a button and this one does not mean "select".
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

/**
 * One step under its session — **pressable, all of them**; only what the press does differs (an
 * agent hands the panel over to its own work, a task travels to its marker inside the session).
 * **Only an agent can wear the selection**, guarded on `kind` here rather than trusted from the
 * caller, and the hover is `--row-active` — alpha, not a flat fill, since this row must answer
 * the pointer over a transparent card, a blue one and a grey one. Reasoning in
 * docs/PACKAGES.md §`packages/ui`.
 */
export function StepRow({
  step,
  active = false,
  onSelect,
}: {
  step: Step
  /** The panel is showing this step's own work. Ignored for tasks. */
  active?: boolean
  onSelect: () => void
}) {
  const agent = step.kind === 'agent'
  const selected = active && agent
  // Body colour by *kind*, state carried by the icon — the transcript's
  // `TaskRow` rule. Green means sub-agent across this product; failure outranks
  // it, because an alarm is not a category.
  const body = step.state === 'failed' ? 'text-danger' : agent ? 'text-success' : 'text-fg-4'
  return (
    <button
      type="button"
      title={step.title}
      aria-current={selected || undefined}
      onClick={(e) => {
        // The whole card is pressable underneath and means "open the session";
        // this row has its own answer, so it must not also fire the card's.
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
      {/* Zero draws nothing: `0 tools` beside a thinking agent reads as a stall. */}
      {step.detail ? <span className="shrink-0 tabular-nums text-fg-4">{step.detail}</span> : null}
      {agent ? <ArrowRight className="size-3.5 shrink-0 text-fg-4" /> : null}
    </button>
  )
}

const StepIcon = ({ state, kind }: { state: Step['state']; kind: Step['kind'] }) => {
  // A task that is neither running nor failed gets a neutral dot rather than a
  // tick: `done` is a claim about work, and nothing here did any.
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
