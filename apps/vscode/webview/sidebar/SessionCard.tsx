import type { SessionInfo } from '@workerdeck/protocol'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  formatRelativeTime,
  cn,
} from '@workerdeck/ui'
import {
  BellRing,
  CircleAlert,
  CircleSlash,
  MoreHorizontal,
  Moon,
  PauseCircle,
  Pencil,
  Square,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { sessionLabel } from './view-config.ts'

/**
 * One session in the sidebar list. Dense on purpose — VS Code sidebars are
 * narrow — but each state is legible at a glance: a live spinner while the
 * agent works, a ringing bell when it waits on a human, a moon when idle.
 *
 * The name is editable in place (double-click, or the ⋯ menu): a session is
 * named on the gateway, so the new name travels to every other client. Clearing
 * it restores the derived title (the first prompt, else the short id).
 */
export function SessionCard({
  info,
  hostName,
  selected,
  onSelect,
  onRename,
  onStop,
  onDelete,
}: {
  info: SessionInfo
  /** Shown when the list isn't already grouped by gateway. */
  hostName?: string
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
  const details = [
    hostName,
    info.engine ?? 'claude',
    info.model,
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
              'min-w-0 flex-1 truncate text-body-sm',
              selected ? 'font-medium text-current' : 'text-fg-2',
            )}>
            {sessionLabel(info)}
          </span>
        )}
        <span className='shrink-0 text-label text-fg-4'>{formatRelativeTime(age)}</span>
        <Menu>
          <MenuTrigger
            render={
              <button
                type='button'
                aria-label='Session actions'
                onClick={(e) => e.stopPropagation()}
                className='shrink-0 rounded p-0.5 text-fg-4 opacity-0 hover:bg-surface-hover hover:text-fg-1 focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100'>
                <MoreHorizontal className='size-3.5' />
              </button>
            }
          />
          <MenuContent>
            <MenuItem onClick={() => setEditing(true)}>
              <Pencil className='size-3.5 text-fg-3' /> Rename
            </MenuItem>
            {running ? (
              <MenuItem onClick={onStop}>
                <Square className='size-3.5 text-fg-3' /> Stop
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem onClick={onDelete}>
              <Trash2 className='size-3.5 text-danger' /> Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className='truncate pl-[1.375rem] text-label text-fg-4'>{details.join(' · ')}</div>
    </div>
  )
}

/** Enter commits, Escape cancels, blur commits — the VS Code inline-rename feel.
 * An empty value is a deliberate "clear the name", which the gateway answers by
 * handing back the derived title. */
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
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      autoFocus
      spellCheck={false}
      placeholder='Session name'
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(value.trim())
        else if (e.key === 'Escape') onCancel()
      }}
      className='min-w-0 flex-1 rounded-sm border border-(--vscode-focusBorder,var(--accent)) bg-bg px-1 py-px text-body-sm text-fg-1 outline-none'
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
