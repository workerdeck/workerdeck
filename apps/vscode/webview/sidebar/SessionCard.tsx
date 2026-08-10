import type { SessionInfo } from '@workerdeck/protocol'
import { Spinner, formatRelativeTime, friendlyModel, cn } from '@workerdeck/ui'
import {
  BellRing,
  CircleAlert,
  CircleSlash,
  Moon,
  PauseCircle,
  Square,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { EngineIcon } from './EngineIcon.tsx'
import { sessionLabel } from '../../src/view-config.ts'

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
  onRename: (title: string) => void
  onStop: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
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
      onClick={onSelect}
      onKeyDown={(e) => {
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
    </div>
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
