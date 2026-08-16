import type { SessionInfo, SubagentInfo } from '@workerdeck/protocol'
import { Spinner, formatRelativeTime, friendlyModel, cn } from '@workerdeck/ui'
import {
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Moon,
  PauseCircle,
  Square,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { EngineIcon } from '@workerdeck/ui'
import { sessionLabel, subagentLabel } from '../../src/view-config.ts'

/**
 * One session in the sidebar list. Dense on purpose — VS Code sidebars are
 * narrow — but each state is legible at a glance: a live spinner while the
 * agent works, a ringing bell when it waits on a human, a moon when idle.
 *
 * Two lines, each with a job. The **title** owns the left edge of the first line
 * because that is what you scan a list by; everything saying *how it is doing* —
 * unread count, age, state — rides the right, state last. The **second line** is
 * what it is (engine mark, model, folder) and what it has spent, with the
 * actions revealed on hover at its far right — away from the state icon, and
 * away from the top line you are actually reading.
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
  onStop,
  onDelete,
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
  onStop: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  // Expansion is the row's own state and deliberately not persisted: a list that
  // reopened yesterday's sub-agents on every window reload would be showing a
  // settled tail nobody asked for. It also cannot be a native twisty — every
  // view in this extension is a webview, so there is no tree to hang one on.
  const [expanded, setExpanded] = useState(false)
  const subagents = info.subagents ?? []
  const runningAgents = subagents.filter((sub) => sub.status === 'running').length
  const needsHuman = info.pendingPermissionCount > 0 || info.status === 'awaiting_approval'
  const running = info.status === 'running' || info.status === 'starting'
  const age = info.lastActivityAt ?? info.createdAt
  const folder = info.cwd.split('/').filter(Boolean).pop() ?? info.cwd
  const engine = info.engine ?? 'claude'
  // The model id as a person says it — `claude-opus-5[1m]` is a wire value, and
  // a sidebar line has no room to spend on a context-window suffix.
  const details = [
    hostName,
    friendlyModel(info.model),
    folder,
    info.numTurns !== undefined ? `${info.numTurns} turn${info.numTurns === 1 ? '' : 's'}` : undefined,
    info.totalCostUsd !== undefined ? `$${info.totalCostUsd.toFixed(2)}` : undefined,
  ].filter(Boolean)

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
        // the disclosure, a sub-agent, a hover action — already fires that
        // control's own click, and `stopPropagation` there cannot help: the
        // keydown is a separate event travelling the same path, so an unguarded
        // handler ran the control's action AND selected the session.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      className={cn(
        'group flex w-full cursor-pointer flex-col gap-0.5 border-l-2 px-2 py-1.5 text-left',
        selected
          ? 'border-l-(--vscode-button-background,var(--accent)) bg-(--vscode-list-activeSelectionBackground,var(--surface-hover)) text-(--vscode-list-activeSelectionForeground,inherit)'
          : 'border-l-transparent hover:bg-surface-hover',
      )}>
      <div className='flex items-center gap-1.5'>
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
              'min-w-0 flex-1 truncate text-body-sm',
              selected ? 'font-medium text-current' : 'text-fg-2',
            )}>
            {sessionLabel(info)}
          </span>
        )}
        {/* What arrived while you were elsewhere. Turns, because that is what
            the sessions poll can count without attaching. */}
        {unseen > 0 ? (
          <span
            title={`${unseen} new turn${unseen === 1 ? '' : 's'} since you last looked`}
            className='shrink-0 rounded-full bg-(--vscode-activityBarBadge-background,var(--accent)) px-1.5 text-label text-(--vscode-activityBarBadge-foreground,var(--accent-fg))'>
            {unseen}
          </span>
        ) : null}
        <span className='shrink-0 text-label text-fg-4'>{formatRelativeTime(age)}</span>
        <StatusIcon needsHuman={needsHuman} running={running} status={info.status} />
      </div>
      <div className='flex items-center gap-1 text-label text-fg-4'>
        <EngineIcon engine={engine} model={info.model} />
        {/* The disclosure lives here, not in front of the title: the first
            line's left edge belongs to the name, which is what you scan the
            list by. It doubles as the count, so the row says how many there are
            without being opened. */}
        {subagents.length > 0 ? (
          <SubagentToggle
            expanded={expanded}
            running={runningAgents}
            total={subagents.length}
            onToggle={() => setExpanded((open) => !open)}
          />
        ) : null}
        <span className='min-w-0 flex-1 truncate'>{details.join(' · ')}</span>
        {running ? (
          <RowAction label='Stop session' onClick={onStop}>
            <Square className='size-3' />
          </RowAction>
        ) : null}
        {/* Delete confirms in a modal on the host side, so the icon is a
            request, not the deed. */}
        <RowAction label='Delete session' danger onClick={onDelete}>
          <Trash2 className='size-3' />
        </RowAction>
      </div>
      {expanded
        ? subagents.map((sub) => (
            <SubagentRow
              key={sub.toolUseId}
              sub={sub}
              onSelect={() => onSelectSubagent(sub.toolUseId)}
            />
          ))
        : null}
    </div>
  )
}

/**
 * The disclosure, which is also the reading: `3 agents` — or `2 of 3 agents`
 * while some have settled, because "how many are still going" is the live
 * question and a bare total answers it wrong the moment one finishes.
 *
 * Sub-agents are an annotation on a working row rather than a state of their
 * own (see `runningSubagents` in protocol's `session-list.ts`), so this never
 * competes with the row's status icon: that still says what the *session* is
 * doing.
 */
function SubagentToggle({
  expanded,
  running,
  total,
  onToggle,
}: {
  expanded: boolean
  running: number
  total: number
  onToggle: () => void
}) {
  const label =
    running > 0 && running < total ? `${running} of ${total} agents` : `${total} agent${total === 1 ? '' : 's'}`
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <button
      type='button'
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} sub-agents`}
      title={`${expanded ? 'Hide' : 'Show'} sub-agents`}
      onClick={(e) => {
        // The whole card is a button and this one does not mean "select" — the
        // same guard `RowAction` needs, and the reason a drag-select inside the
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
      {label}
    </button>
  )
}

/**
 * One sub-agent under its session. Pressing it opens the session *at* that
 * `Task`'s row — a sub-agent is not a session and has no screen of its own, so
 * that is the only honest meaning of opening one.
 *
 * The label is protocol's `subagentLabel`, not a spelling of its own: the
 * dashboard and the phone render the same rows from the same records, and two
 * spellings would be two different answers to "which agent is this".
 */
function SubagentRow({ sub, onSelect }: { sub: SubagentInfo; onSelect: () => void }) {
  return (
    <button
      type='button'
      title={`${subagentLabel(sub)} · ${sub.toolCount} tool${sub.toolCount === 1 ? '' : 's'}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      /* Stepped in to sit under the details line, with the same rule the
         terminal theme's nested rows use: the indent is the whole signal that
         this happened *inside* the row above it. */
      className='flex w-full items-center gap-1.5 rounded py-0.5 pl-4 text-left text-label text-fg-4 outline-none hover:bg-surface-hover hover:text-fg-2'>
      <SubagentIcon status={sub.status} />
      <span className='min-w-0 flex-1 truncate'>{subagentLabel(sub)}</span>
      {/* The progress reading while it works, and what it cost when it is done.
          Zero draws nothing: `0 tools` beside a thinking agent reads as a stall,
          which is the same call `taskSummary` makes one surface over. */}
      {sub.toolCount > 0 ? <span className='shrink-0 tabular-nums'>{sub.toolCount}</span> : null}
    </button>
  )
}

function SubagentIcon({ status }: { status: SubagentInfo['status'] }) {
  switch (status) {
    case 'running':
      return <Spinner className='size-3 shrink-0 text-info' />
    case 'failed':
      return <CircleAlert className='size-3 shrink-0 text-danger' />
    default:
      return <Check className='size-3 shrink-0 text-fg-4' />
  }
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

/** An action on the card's second line: invisible until the row is hovered or
 * something in it is focussed, so a dense list stays a list. */
function RowAction({
  label,
  danger,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      onClick={(e) => {
        // The whole card is a button; this one does not mean "select".
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'shrink-0 rounded p-0.5 text-fg-4 opacity-0 transition-opacity outline-none',
        'hover:bg-surface-hover focus-visible:opacity-100 group-hover:opacity-100',
        danger ? 'hover:text-danger' : 'hover:text-fg-1',
      )}>
      {children}
    </button>
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
