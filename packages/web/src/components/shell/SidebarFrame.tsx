import { useState, type ReactNode } from 'react'
import { Button, Splitter, cn } from '@workerdeck/ui'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import {
  SIDEBAR_MAX,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  getSidebarCollapsed,
  getSidebarWidth,
  setSidebarCollapsed,
  setSidebarWidth,
  type SidebarSection,
} from '@/lib/sidebar.ts'

export interface SidebarFrameProps {
  /** Which sidebar this is — the key its width and collapsed state persist under. */
  section: SidebarSection
  /** Small-caps view title, VS Code's shape. Not a page heading. */
  title: string
  /** One fact worth having without expanding anything, beside the title — the
   * connected-gateway count, the number of running jobs. */
  badge?: ReactNode
  /** View actions, right of the title. The `+` that creates goes last, as it
   * does in VS Code and in the extension. */
  actions?: ReactNode
  children: ReactNode
  /**
   * What the collapsed rail shows instead of the list.
   *
   * Optional, and its absence is meaningful: a section whose rows carry nothing
   * legible at 44px — a job's prompt, a profile's name — collapses to the
   * expand button alone rather than to a column of identical glyphs. Sessions
   * has one because an engine mark plus a state icon really does identify a row.
   */
  rail?: ReactNode
  /** Rail actions above the rail body — usually the same `+`, icon-only. */
  railActions?: ReactNode
}

/**
 * The frame every section sidebar shares: view header, collapse toggle,
 * persisted width, and the splitter that resizes it.
 *
 * It exists because there are four of these now and they must agree on the
 * chrome — a sidebar that headed itself differently per section would read as
 * four apps rather than one. What it deliberately does *not* own is the list:
 * each section's rows, filtering and empty state are its own business, since
 * they have nothing in common beyond sitting in this box.
 */
export function SidebarFrame({ section, title, badge, actions, children, rail, railActions }: SidebarFrameProps) {
  const [width, setWidth] = useState(() => getSidebarWidth(section))
  const [collapsed, setCollapsed] = useState(() => getSidebarCollapsed(section))

  const toggle = (next: boolean) => {
    setCollapsed(next)
    setSidebarCollapsed(section, next)
  }

  if (collapsed) {
    return (
      <div className="flex min-h-0 w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label={`Expand ${title.toLowerCase()}`} onClick={() => toggle(false)}>
          <PanelLeftOpen className="size-4" />
        </Button>
        {railActions}
        {rail ? <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pt-1">{rail}</div> : null}
      </div>
    )
  }

  return (
    <>
      <div style={{ width }} className="flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar">
        {/* VS Code's view header: a small-caps title and the actions that belong
            to the view, not a page heading. */}
        <header className="flex h-9 shrink-0 items-center gap-1 pr-1 pl-3">
          <span className="truncate text-label font-medium tracking-wide text-fg-3 uppercase">{title}</span>
          {badge}
          <span className="flex-1" />
          <Button variant="ghost" size="icon-sm" aria-label={`Collapse ${title.toLowerCase()}`} onClick={() => toggle(true)}>
            <PanelLeftClose className="size-3.5" />
          </Button>
          {actions}
        </header>
        {children}
      </div>

      <Splitter
        orientation="vertical"
        value={width}
        onValueChange={(next) => {
          setWidth(next)
          setSidebarWidth(section, next)
        }}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        defaultValue={SIDEBAR_DEFAULT}
        aria-label={`Resize ${title.toLowerCase()} sidebar`}
      />
    </>
  )
}

/** The scrolling body most sidebars want under the header. */
export function SidebarBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto pb-2', className)}>{children}</div>
}
