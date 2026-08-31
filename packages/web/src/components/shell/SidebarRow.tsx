import type { ReactNode } from 'react'
import { cn, rowShapeClass } from '@workerdeck/ui'

export interface SidebarRowProps {
  title: ReactNode
  status?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  active?: boolean
  onSelect?: () => void
  onDoubleClick?: () => void
}

export function SidebarRow({ title, status, description, actions, active, onSelect, onDoubleClick }: SidebarRowProps) {
  return (
    <div
      data-slot="sidebar-row"
      data-active={active || undefined}
      // The whole row selects; the inner buttons exist for keyboard reach and bubble here, so there is no double-fire.
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={cn('group flex cursor-pointer flex-col gap-0.5 text-left transition-colors', rowShapeClass(active === true))}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={cn('min-w-0 flex-1 truncate text-left text-body-sm outline-none', active ? 'font-medium text-fg-1' : 'text-fg-2')}
        >
          {title}
        </button>
        {status}
      </div>
      <div className="flex items-center gap-1 text-label text-fg-4">
        <button type="button" tabIndex={-1} className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left font-mono outline-none">
          {description}
        </button>
        {actions}
      </div>
    </div>
  )
}

export function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // The row is the selection target, and an action is not a slower way of opening the thing.
        e.stopPropagation()
        onClick()
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded text-fg-3 opacity-0 transition-opacity outline-none hover:bg-surface-hover hover:text-fg-1 group-hover:opacity-100"
    >
      {children}
    </button>
  )
}
