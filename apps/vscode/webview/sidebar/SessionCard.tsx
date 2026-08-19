import type { SessionInfo, SubagentInfo } from '@workerdeck/protocol'
import { Spinner, formatRelativeTime, friendlyModel, cn } from '@workerdeck/ui'
import {
  ArrowRight,
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  MoreHorizontal,
  Moon,
  PauseCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { EngineIcon, engineMark } from '@workerdeck/ui'
import { sessionLabel, subagentLabel } from '../../src/view-config.ts'

/**
 * One session in the sidebar list — an inset rounded **card**, two lines and an
 * optional list of work under them.
 *
 * **Line one is what it is doing and what it is called**: the state leads, as a
 * glyph in front of the title, and the unread count closes the line. The glyph
 * leads because a sessions list is scanned for *state* first — which of these is
 * working, which is waiting on me — and the title is what you read once the
 * glyph has told you which row to read. (This reverses an earlier rule, "the
 * title owns the left edge"; the earlier rule optimised for reading one row and
 * this one for scanning twenty.) The title also **dims when the session is not
 * live**: an idle row is context, and spending full contrast on twelve of them
 * is what made the one that is working hard to find.
 *
 * **Line two is what it is**: the engine's mark and its model in the engine's
 * own colour, then the folder and the age, muted. The colour is a *vendor* cue —
 * it sits against the mark and identifies whose engine this is — which is why it
 * survives this webview's rule that a lone coral element reads as a stray token
 * (`styles.css`, the `--term-mark` repoint). That rule is about the panel's
 * working marker, where coral competed with the editor's accent for the same
 * meaning; here it competes with nothing and names Anthropic.
 *
 * **Selection is the card's own fill**, not a gutter bar: the card is already an
 * inset shape with air around it, so filling it is unambiguous in a way a fill
 * on a full-bleed row is not, and it leaves the left edge to the state glyph.
 * Hover is the same fill one step down.
 *
 * The name is editable in place by **double-clicking it** — there is no menu
 * entry, because a rename is a thing you do to the word you are looking at. A
 * session is named on the gateway, so the new name travels to every other
 * client; clearing it restores the derived title.
 */
export function SessionCard({
  info,
  hostName,
  unseen = 0,
  selected,
  onSelect,
  onSelectSubagent,
  onRename,
  onMenu,
}: {
  info: SessionInfo
  /** Shown when the list isn't already grouped by gateway. */
  hostName?: string
  /** Turns since this session was last on screen. 0 draws no badge. */
  unseen?: number
  selected: boolean
  onSelect: () => void
  /** Open the session *at* one of its sub-agents — see `wd-select-session`'s
   * `revealToolUse`. */
  onSelectSubagent: (toolUseId: string) => void
  onRename: (title: string) => void
  /** Open the card's overflow menu. Native, host-side — see `onMenu` below. */
  onMenu: () => void
}) {
  const [editing, setEditing] = useState(false)
  // Expansion is the row's own state and deliberately not persisted: a list that
  // reopened yesterday's work on every window reload would be showing a settled
  // tail nobody asked for. It also cannot be a native twisty — every view in
  // this extension is a webview, so there is no tree to hang one on.
  const [expanded, setExpanded] = useState(false)
  const steps = sessionSteps(info, onSelectSubagent)
  const running = info.status === 'running' || info.status === 'starting'
  const needsHuman = info.pendingPermissionCount > 0 || info.status === 'awaiting_approval'
  const live = running || needsHuman
  const age = info.lastActivityAt ?? info.createdAt
  const folder = info.cwd.split('/').filter(Boolean).pop() ?? info.cwd
  const engine = info.engine ?? 'claude'
  // The model id as a person says it — `claude-opus-5[1m]` is a wire value, and
  // a sidebar line has no room to spend on a context-window suffix.
  const model = friendlyModel(info.model)
  // Only Anthropic's coral is carried (see `--wd-vendor` in `styles.css`);
  // everything else keeps the muted line it always had rather than being given
  // a colour invented for it here.
  const vendor = engineMark(engine, info.model) === 'claude' ? 'text-vendor' : 'text-fg-3'
  const rest = [hostName, folder, formatRelativeTime(age)].filter(Boolean).join(' · ')

  return (
    <div
      role='button'
      tabIndex={0}
      /* Only the FIRST click of a click-streak selects. Selecting reveals the
         agent panel and focuses its composer (`panel.show({ focus: true })`),
         so the second click of a double-click would steal focus a beat after
         the rename editor mounted — the editor appearing and vanishing in the
         same gesture. `detail` counts the streak; anything past the first is
         the double-click the title is listening for. */
      onClick={(e) => {
        if (e.detail > 1) return
        onSelect()
      }}
      onKeyDown={(e) => {
        // Only when the card ITSELF has focus. A press on something inside it —
        // the disclosure, a step, the menu — already fires that control's own
        // click, and `stopPropagation` there cannot help: the keydown is a
        // separate event travelling the same path, so an unguarded handler ran
        // the control's action AND selected the session.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      className={cn(
        'group flex w-full cursor-pointer flex-col overflow-hidden rounded-[5px] text-left',
        selected
          ? 'bg-(--vscode-list-activeSelectionBackground,var(--surface-hover)) text-(--vscode-list-activeSelectionForeground,inherit)'
          : 'hover:bg-(--vscode-list-hoverBackground,var(--surface-hover))',
      )}>
      <div className='flex flex-col gap-1 px-2.5 py-1.5'>
        <div className='flex items-center gap-1.5 overflow-hidden'>
          <StatusIcon needsHuman={needsHuman} running={running} status={info.status} />
          {editing ? (
            <NameEditor
              initial={info.title ?? ''}
              onCommit={(title) => {
                setEditing(false)
                if (title !== (info.title ?? '')) onRename(title)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
              className={cn(
                'min-w-0 flex-1 truncate text-body-sm font-medium',
                live || selected ? 'text-fg-1' : 'text-fg-3',
              )}>
              {sessionLabel(info)}
            </span>
          )}
          {/* What arrived while you were elsewhere. Turns, because that is what
              the sessions poll can count without attaching. */}
          {unseen > 0 ? (
            <span
              title={`${unseen} new turn${unseen === 1 ? '' : 's'} since you last looked`}
              className='shrink-0 rounded-full bg-(--vscode-activityBarBadge-background,var(--accent)) px-2 py-0.5 text-label leading-none text-(--vscode-activityBarBadge-foreground,var(--accent-fg))'>
              {unseen}
            </span>
          ) : null}
        </div>
        <div className='flex items-center gap-1.5 overflow-hidden text-label'>
          <span className={cn('shrink-0', vendor)}>
            <EngineIcon engine={engine} model={info.model} />
          </span>
          <span className='min-w-0 flex-1 truncate'>
            <span className={vendor}>{model}</span>
            {rest ? <span className='text-fg-4'>{` · ${rest}`}</span> : null}
          </span>
          {/* The disclosure lives here, not in front of the title: line one's
              left edge belongs to the state glyph and the name. It doubles as
              the count, so the row says how much there is without being
              opened. */}
          {steps.length > 0 ? (
            <StepToggle
              expanded={expanded}
              running={steps.filter((s) => s.state === 'running').length}
              total={steps.length}
              noun={steps[0]!.noun}
              onToggle={() => setExpanded((open) => !open)}
            />
          ) : null}
          {/* Always visible, not hover-revealed. A hover action is undiscoverable
              on a touchpad-shy scan and there are three of them now; one glyph
              that opens a native menu costs the row less than three icons. */}
          <CardMenu onOpen={onMenu} />
        </div>
      </div>
      {expanded
        ? steps.map((step) => <StepRow key={step.key} step={step} onSelect={step.onSelect} />)
        : null}
    </div>
  )
}

/**
 * A line of work under a session, and the one row shape two sources render
 * through.
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
type Step = {
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

function sessionSteps(info: SessionInfo, onSelectSubagent: (toolUseId: string) => void): Step[] {
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

/**
 * The disclosure, which is also the reading: `3 agents` — or `2 of 3 agents`
 * while some have settled, because "how many are still going" is the live
 * question and a bare total answers it wrong the moment one finishes.
 *
 * Sub-agents are an annotation on a working row rather than a state of their
 * own (see `runningSubagents` in protocol's `session-list.ts`), so this never
 * competes with the row's status glyph: that still says what the *session* is
 * doing.
 */
function StepToggle({
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
  // this sits on the second line of a 280px card next to the folder and the age,
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
        // The whole card is a button and this one does not mean "select" — the
        // same guard `CardMenu` needs, and the reason a drag-select inside the
        // row does not toggle it.
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
 * Divided from the card's header and from each other by a rule rather than by
 * indentation: these are a list *inside* the card, and at 11px an indent is not
 * enough to say so. The rule is black at 25% so it darkens whatever the card is
 * filled with, selected or not, without needing a colour per state.
 */
function StepRow({ step, onSelect }: { step: Step; onSelect: () => void }) {
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
        'hover:bg-(--vscode-list-hoverBackground,var(--surface-hover))',
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

/**
 * The card's overflow. The menu itself is a native QuickPick, opened host-side:
 * no webview in this extension draws its own chrome, and a popover anchored in a
 * sidebar this narrow would be clipped by the view's own bounds anyway.
 */
function CardMenu({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type='button'
      aria-label='Session actions'
      title='Session actions'
      onClick={(e) => {
        // The whole card is a button; this one does not mean "select".
        e.stopPropagation()
        onOpen()
      }}
      className='shrink-0 rounded p-0.5 text-fg-4 outline-none hover:bg-surface-hover hover:text-fg-1'>
      <MoreHorizontal className='size-3.5' />
    </button>
  )
}

/**
 * Enter commits, Escape cancels, blur commits — the VS Code inline-rename feel.
 * An empty value is a deliberate "clear the name", which the gateway answers by
 * handing back the derived title.
 *
 * The blur rule needs one guard. Selecting a session focuses the agent panel —
 * a different VS Code view — so this webview's document can lose focus a tick
 * after a double-click opened the editor, and an unguarded blur reads that as
 * "the user clicked away" and closes the editor in the frame it appeared.
 * `document.hasFocus()` tells the two apart: focus moving WITHIN this webview is
 * the user leaving the field; the whole webview losing focus is not. When the
 * window comes back, so does the caret.
 */
function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  useEffect(() => {
    const onWindowFocus = () => {
      ref.current?.focus()
      ref.current?.select()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      placeholder='Session name'
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (document.hasFocus()) onCommit(value.trim())
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(value.trim())
        else if (e.key === 'Escape') onCancel()
      }}
      /* The negative margin is load-bearing: the border (1px) and padding (1px)
         make the input 4px taller than the label it replaces, and the card would
         grow by that much the moment a rename starts. -2px per side cancels it
         exactly, so the row keeps its height and the list never shifts. */
      className='-my-0.5 min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder,var(--accent)) bg-bg px-1 py-px text-body-sm leading-5 text-fg-1 outline-none'
    />
  )
}

function StatusIcon({
  needsHuman,
  running,
  status,
}: {
  needsHuman: boolean
  running: boolean
  status: SessionInfo['status']
}) {
  if (needsHuman) return <BellRing className='size-3.5 shrink-0 animate-pulse text-warning' />
  if (running) return <Spinner className='size-3.5 shrink-0 text-info' />
  switch (status) {
    case 'failed':
      return <CircleAlert className='size-3.5 shrink-0 text-danger' />
    case 'closed':
      return <CircleSlash className='size-3.5 shrink-0 text-fg-4' />
    case 'parked':
      return <PauseCircle className='size-3.5 shrink-0 text-fg-3' />
    default:
      return <Moon className='size-3.5 shrink-0 text-fg-4' />
  }
}
