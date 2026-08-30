import type { ReactNode } from 'react'
import { cn, rowShapeClass } from '@workerdeck/ui'

export interface SidebarRowProps {
  /** Top left: what you scan the list by. */
  title: ReactNode
  /** Top right: how it is doing — a badge, an age, a state glyph. */
  status?: ReactNode
  /** Bottom left: what it is. Monospace, one line, truncated. */
  description?: ReactNode
  /** Bottom right: what you can do to it. Revealed on hover, so the line you
   * actually read is not competing with buttons that are usually irrelevant. */
  actions?: ReactNode
  active?: boolean
  onSelect?: () => void
  onDoubleClick?: () => void
}

/**
 * One row in a section sidebar. The shape is `rowShapeClass` in `@workerdeck/ui`,
 * which `SessionBrowser` draws its rows with too, so every list hovers identically
 * — fill means hover, selection is the accent bar.
 *
 * The anatomy is fixed on purpose (title top-left, status top-right, description
 * bottom-left, actions bottom-right), and there is deliberately **no leading
 * glyph**: an icon in front of the title pushes the thing you are reading off the
 * left edge, so an engine mark goes on the description line instead.
 */
export function SidebarRow({ title, status, description, actions, active, onSelect, onDoubleClick }: SidebarRowProps) {
  return (
    <div
      data-slot="sidebar-row"
      data-active={active || undefined}
      // The whole row selects, including the status corner, which sits outside the two text
      // buttons. Those stay for keyboard reach: activating one bubbles here, so there is one
      // path and no double-fire, and `RowAction` stops the event.
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group flex cursor-pointer flex-col gap-0.5 text-left transition-colors',
        // Borrowed from `SessionBrowser`, not restated: two copies of one fill is how a list
        // comes to hover differently from the list beside it.
        rowShapeClass(active === true),
      )}
    >
      {/* Both lines are real buttons and the wrapper is only styling: a div with an `onClick`
          is unreachable by keyboard, and one button around everything cannot hold the actions. */}
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

/** An action on a row: an icon button that appears on hover, at the far right of
 * the description line. The one shape all four lists use. */
export function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        // The row is the selection target; an action is not a slower way of opening the thing.
        e.stopPropagation()
        onClick()
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded text-fg-3 opacity-0 transition-opacity outline-none hover:bg-surface-hover hover:text-fg-1 group-hover:opacity-100"
    >
      {children}
    </button>
  )
}
