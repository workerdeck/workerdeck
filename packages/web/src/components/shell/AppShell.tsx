import { useState, type ReactNode } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { ListChecks, PanelLeftClose, PanelLeftOpen, Plug, Settings, SquareTerminal, UsersRound } from 'lucide-react'
import { cn } from '@workerdeck/ui'
import { SettingsDialog } from '@/components/SettingsDialog.tsx'
import { BrandMark } from './BrandMark.tsx'
import { GatewaysSidebar } from './GatewaysSidebar.tsx'
import { JobsSidebar } from './JobsSidebar.tsx'
import { ProfilesSidebar } from './ProfilesSidebar.tsx'
import { SessionsSidebar } from './SessionsSidebar.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

/**
 * The activity bar. Every entry is a *section* — a list on the left, a detail pane
 * beside it — which is why each names its own sidebar **here** rather than mounting
 * one from a route: navigating within a section must not replace the list you
 * picked from. Settings is absent on purpose; it is a dialog, not a section.
 */
const NAV = [
  { id: 'sessions', label: 'Sessions', icon: SquareTerminal, path: '/sessions', sidebar: SessionsSidebar },
  { id: 'gateways', label: 'Gateways', icon: Plug, path: '/gateways', sidebar: GatewaysSidebar },
  { id: 'jobs', label: 'Jobs', icon: ListChecks, path: '/jobs', sidebar: JobsSidebar },
  { id: 'profiles', label: 'Profiles', icon: UsersRound, path: '/profiles', sidebar: ProfilesSidebar },
] as const

const COLLAPSED_KEY = 'workerdeck.sidebar-collapsed'

export function AppShell({ children }: { children?: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Longest match wins, so `/gateways` never loses to a prefix of itself.
  const section = [...NAV].sort((a, b) => b.path.length - a.path.length).find((item) => pathname.startsWith(item.path))
  const Sidebar = section?.sidebar
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    setCollapsed((prev) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, prev ? '0' : '1')
      } catch {
        // private mode etc. — the preference just won't persist
      }
      return !prev
    })
  }
  // One spelling for the three foot icons, so they answer the pointer identically.
  const footIconClass =
    'flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors outline-none hover:bg-row-hover hover:text-fg-1'
  const itemClass = (active: boolean) =>
    cn(
      'flex items-center rounded-md text-body-sm transition-colors outline-none',
      collapsed ? 'justify-center p-2' : 'gap-2 px-2 py-1.5',
      active ? 'bg-surface font-medium text-fg-1 shadow-(--shadow-xs)' : 'text-fg-3 hover:bg-row-hover hover:text-fg-1',
    )
  return (
    <div className="flex h-dvh bg-sidebar">
      <aside className={cn('flex shrink-0 flex-col gap-1 p-3 transition-[width] duration-150', collapsed ? 'w-14 items-center' : 'w-52')}>
        <div className={cn('flex items-center py-2', collapsed ? 'justify-center' : 'gap-2 px-2')}>
          <BrandMark className="size-4 shrink-0 text-fg-1" />
          {!collapsed && <span className="text-body-sm font-semibold tracking-tight text-fg-1">workerdeck</span>}
        </div>
        <nav className={cn('mt-1 flex flex-1 flex-col gap-0.5', collapsed && 'items-center')}>
          {NAV.map((item) => (
            <Link
              key={item.id}
              to={item.path}
              title={collapsed ? item.label : undefined}
              aria-label={item.label}
              // Already in this section: stay put. Navigating to the section root from inside
              // it would close whatever you have open.
              onClick={(e) => {
                if (item.id === section?.id) {
                  e.preventDefault()
                }
              }}
              className={itemClass(item.id === section?.id)}
            >
              <item.icon className="size-4 shrink-0" />
              {!collapsed && item.label}
            </Link>
          ))}
        </nav>
        {/* Icons rather than nav rows: none of the three is a place you navigate to. Spread
            across the bar's own axis — a column when collapsed, a row when not. */}
        <div className={cn('mt-1 grid place-items-center gap-1', collapsed ? 'grid-rows-3' : 'grid-cols-3')}>
          <button type="button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings" className={footIconClass}>
            <Settings className="size-4" />
          </button>
          <ThemeToggle />
          <button
            type="button"
            onClick={toggle}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={footIconClass}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
      </aside>
      {/* The sidebar and the editor area share ONE frame: two panes of the same surface, so a
          seam of desktop between them would read as two windows. `overflow-hidden` clips the
          sidebar into the rounded corners. Keyed on the section so switching mounts a fresh
          sidebar rather than reconciling one list component into another's shape. */}
      <div className="app-frame frame-shine m-2 ml-0 flex min-w-0 flex-1 overflow-hidden rounded-xl">
        {Sidebar ? <Sidebar key={section?.id} /> : null}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children ?? <Outlet />}</main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
