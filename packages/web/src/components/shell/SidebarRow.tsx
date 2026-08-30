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
 * One row in a section sidebar: a rounded inset card, hover and selection
 * carried by **fill** rather than by a left edge.
 *
 * The shape comes from `rowShapeClass` in `@workerdeck/ui`, which is also what
 * `SessionBrowser` draws its rows with — so all four section lists hover
 * identically. The fill is the `row-hover` **alpha** token: a flat colour tuned
 * for one background is invisible on another, which is exactly how
 * `bg-surface-hover` on the dark sidebar came to be one step of 255 away from
 * it. Selection is the accent bar, not a fill — see `rowShapeClass`.
 *
 * The anatomy is fixed on purpose — title top-left, status top-right,
 * description bottom-left, actions bottom-right — because a reader scanning
 * four different sections should not have to re-learn where the state lives.
 * Note what is *not* here: a leading glyph. An icon in front of the title
 * pushes the one thing you are reading off the left edge, so anything
 * identifying (an engine mark) belongs on the description line, where it lines
 * up under the title rather than displacing it.
 */
export function SidebarRow({ title, status, description, actions, active, onSelect, onDoubleClick }: SidebarRowProps) {
  return (
    <div
      data-slot="sidebar-row"
      data-active={active || undefined}
      // The whole row selects, including the status corner: `status` and
      // `actions` sit outside the two text buttons, so with the handler on the
      // buttons alone the right-hand third of every row did nothing. The
      // buttons stay for keyboard reach — activating one fires a click that
      // bubbles here, so there is one path and no double-fire — and `RowAction`
      // stops the event, since an action is not a slower way of opening a thing.
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group flex cursor-pointer flex-col gap-0.5 text-left transition-colors',
        // Borrowed from `SessionBrowser` rather than restated: the dashboard's
        // sessions list is that component, and two hand-written copies of the
        // same fill is how one list comes to hover differently from the list
        // beside it.
        rowShapeClass(active === true),
      )}
    >
      {/* Both lines are real buttons, and the wrapper is only styling. A div
          with an `onClick` looks identical and is unreachable by keyboard — and
          a single button around everything cannot hold the row actions, since a
          button inside a button is invalid. This is the shape `SessionBrowser`
          arrived at for the same two reasons. */}
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
        // The row itself is the click target for selection; an action is not a
        // slower way of opening the thing.
        e.stopPropagation()
        onClick()
      }}
      className="flex size-5 shrink-0 items-center justify-center rounded text-fg-3 opacity-0 transition-opacity outline-none hover:bg-surface-hover hover:text-fg-1 group-hover:opacity-100"
    >
      {children}
    </button>
  )
}
