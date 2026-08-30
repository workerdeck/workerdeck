import type { SessionInfo } from '@workerdeck/protocol'
import { Trash2 } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatRelativeTime } from '../../lib/format.ts'
import { STATUS_META } from './status.ts'

export interface SessionListItemProps {
  session: SessionInfo
  active?: boolean
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
  className?: string
}

export function SessionListItem({ session, active, onSelect, onDelete, className }: SessionListItemProps) {
  const meta = STATUS_META[session.status]
  return (
    <div
      data-slot="session-list-item"
      data-active={active || undefined}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors',
        active ? 'border-border bg-surface' : 'hover:bg-surface-hover',
        className,
      )}
    >
      <button type="button" onClick={() => onSelect?.(session.id)} className="min-w-0 flex-1 text-left outline-none">
        <div className="flex items-center gap-2">
          <span className="truncate text-body-sm font-medium text-fg-1">{session.title ?? session.id.slice(0, 8)}</span>
          <Badge variant={meta.variant} dot className="shrink-0">
            {meta.label}
          </Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-label text-fg-4">
          <span className="truncate">{session.cwd}</span>
          {session.profile ? <span className="shrink-0">@{session.profile}</span> : null}
          <span className="shrink-0">{formatCost(session.totalCostUsd)}</span>
          <span className="shrink-0">{formatRelativeTime(session.lastActivityAt ?? session.createdAt)}</span>
        </div>
      </button>
      {onDelete ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close session"
          className="opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => onDelete(session.id)}
        >
          <Trash2 className="size-3.5 text-fg-3" />
        </Button>
      ) : null}
    </div>
  )
}

export interface SessionListProps {
  sessions: SessionInfo[]
  activeId?: string
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
  emptyText?: string
  className?: string
}

export function SessionList({ sessions, activeId, onSelect, onDelete, emptyText = 'No sessions yet.', className }: SessionListProps) {
  return (
    <div data-slot="session-list" className={cn('flex flex-col gap-1', className)}>
      {sessions.length === 0 ? (
        <div className="px-2.5 py-6 text-center text-body-sm text-fg-4">{emptyText}</div>
      ) : (
        sessions.map((session) => (
          <SessionListItem key={session.id} session={session} active={session.id === activeId} onSelect={onSelect} onDelete={onDelete} />
        ))
      )}
    </div>
  )
}
