import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Dot,
  PauseCircle,
} from 'lucide-react'
import { isAgentRecord, subagentLabel } from '@workerdeck/protocol'
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
  /**
   * An **agent** has an identity and work of its own, so it is pressable and
   * wears the sub-agent colour. A **task** is something the model described with
   * no agent behind it (`isAgentRecord`), so it is inert: there is no frame to
   * open, and a row that offered one would show an empty screen.
   *
   * Two values and not a boolean because the checklist source this shape was
   * drawn for (see above) produces the second kind natively — a to-do is a task
   * in exactly this sense, and it will slot in here rather than widening
   * anything.
   */
  kind: 'agent' | 'task'
  state: 'done' | 'running' | 'pending' | 'failed'
  /** A trailing reading — a sub-agent's tool count. Absent draws nothing. */
  detail?: string
  title: string
  onSelect: () => void
}

/**
 * The steps under one session, **agents first**.
 *
 * The two kinds do different things when pressed and are worth different
 * amounts of attention: an agent has work of its own to go and read, a task is a
 * marker in a transcript. Interleaved in dispatch order they read as one
 * undifferentiated list, and the rows you can actually open are scattered
 * through it. Grouped, the openable ones are a block at the top and the markers
 * are a tail you can skip.
 *
 * Stable **within** each group, deliberately: dispatch order is the only order
 * these records have that means anything (it is the order the work was started
 * in), so the sort partitions and never reorders inside a partition.
 *
 * `onSelect` is handed the **kind** as well as the id, because the two kinds go
 * to different places — see `SessionItem`, which is what routes them. Passing
 * only the id is what let a task be opened as if it were an agent, and a framed
 * task id matches no items, so the panel drew an **empty agent view**.
 */
export function sessionSteps(
  info: SessionInfo,
  onSelect: (toolUseId: string, kind: Step['kind']) => void,
): Step[] {
  // The label is protocol's `subagentLabel`, not a spelling of its own: the
  // dashboard and the phone render the same rows from the same records, and two
  // spellings would be two different answers to "which agent is this".
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
        'flex shrink-0 items-center gap-0.5 rounded-[4px] py-0.5 pr-1 pl-0.5 outline-none',
        'text-[0.75rem] leading-3 hover:bg-row-hover hover:text-fg-2',
        running > 0 ? 'text-info' : 'text-fg-4',
      )}>
      <Chevron className='size-3' />
      <span className='tabular-nums'>{label}</span>
    </button>
  )
}

/**
 * One step under its session — **pressable, all of them**, and what a press
 * means is what tells the two kinds apart.
 *
 * Pressing an **agent** hands the panel over to that agent's own work
 * (`SessionPanel.openSubagent`): it is not a session and never becomes one, but
 * it has a surface, so it can be the selected thing. Pressing a **task** selects
 * the *session* and travels to that task's marker inside it — a task is a
 * reference to a place in a transcript, not a thing with a screen, so it can be
 * followed but never held.
 *
 * That is a reversal, and a deliberate one. A task used to be inert markup on
 * the argument that "a disabled-looking button still announces itself as one" —
 * correct about the markup, wrong about the premise, because there *was* always
 * somewhere to go and the row simply swallowed the click on its way there. A row
 * that looks like a list item, sits in a list, and does nothing when pressed is
 * the worse lie. So every step answers the pointer and every step answers a
 * press; only what the press does differs.
 *
 * Divided from the card's header by **indentation and its own hit shape**, not
 * by a rule. The rules came first, on the argument that at 11px an indent is not
 * enough to say "list inside a row" — and they were right about the reading and
 * wrong about the cost: a stack of hairlines across every open card turned the
 * list into a ledger, and a rule cannot answer a pointer. A step that lights up
 * under the cursor and fills when it is the one on screen says *list* far more
 * plainly than a line between two of them, and it says it while doing the job
 * the rule could not.
 *
 * **Only an agent can wear the selection**, and `active` is guarded on that here
 * rather than trusted from the caller: a host that hands back a task's key is
 * describing where it navigated, not what it selected, and the row must not
 * paint itself blue for it.
 *
 * The hover is `--row-active` — **alpha, not a flat fill** — because this row
 * has to answer the pointer on three different grounds: a transparent card, a
 * blue one (its session is selected), and a grey one (a sibling agent is). A
 * flat value tuned for any of those is wrong on the other two; a tint darkens or
 * lifts whatever it lands on. It is the one place in the list where the alpha
 * token earns its keep.
 */
export function StepRow({
  step,
  active = false,
  onSelect,
}: {
  step: Step
  /** The panel is showing this step's own work. Ignored for tasks, which cannot
   * be the selected thing — see above. */
  active?: boolean
  onSelect: () => void
}) {
  const agent = step.kind === 'agent'
  const selected = active && agent
  // Body colour by *kind*, state carried by the icon — the rule the transcript's
  // own `TaskRow` already follows, where the body is green and the marker holds
  // the beat. Green means sub-agent across this product (it is the one hue
  // nothing else on a session surface claims), so a list that spent blue on
  // "running" here would be saying something different from the transcript
  // about the same agent. Failure still outranks it: an alarm is not a category.
  const body = step.state === 'failed' ? 'text-danger' : agent ? 'text-success' : 'text-fg-4'
  return (
    <button
      type='button'
      title={step.title}
      aria-current={selected || undefined}
      onClick={(e) => {
        // The whole card is pressable underneath and means "open the session".
        // This row has its own answer — for an agent a different destination,
        // for a task the same one plus a place to land — so it must not also
        // fire the card's.
        e.stopPropagation()
        onSelect()
      }}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-[4px] py-1 pr-2.5 pl-3.5',
        'text-left text-micro outline-none',
        selected ? 'bg-row-selected' : 'hover:bg-row-active',
        body,
      )}>
      <StepIcon state={step.state} kind={step.kind} />
      <span className='min-w-0 flex-1 truncate'>{step.label}</span>
      {/* The progress reading while it works, and what it cost when it is done.
          Zero draws nothing: `0 tools` beside a thinking agent reads as a stall,
          which is the same call `taskSummary` makes one surface over. */}
      {step.detail ? <span className='shrink-0 tabular-nums text-fg-4'>{step.detail}</span> : null}
      {agent ? <ArrowRight className='size-3.5 shrink-0 text-fg-4' /> : null}
    </button>
  )
}

function StepIcon({ state, kind }: { state: Step['state']; kind: Step['kind'] }) {
  // A task that is neither running nor failed gets a neutral dot rather than a
  // tick: `done` is a claim about work, and nothing here did any.
  if (kind === 'task' && state !== 'running' && state !== 'failed') {
    return <Dot className='size-[11px] shrink-0' />
  }
  switch (state) {
    case 'running':
      return <Spinner className='size-[11px] shrink-0' />
    case 'failed':
      return <CircleAlert className='size-[11px] shrink-0' />
    case 'pending':
      return <PauseCircle className='size-[11px] shrink-0' />
    default:
      return <Check className='size-[11px] shrink-0' />
  }
}
