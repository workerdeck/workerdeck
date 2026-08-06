import { useState, type ReactNode } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { ListChecks, PanelLeftClose, PanelLeftOpen, Settings, SquareTerminal, UsersRound } from 'lucide-react'
import { cn } from '@workerdeck/ui'
import { APP_VERSION } from '@/lib/version.ts'
import { BrandMark } from './BrandMark.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

const NAV = [
  { id: 'sessions', label: 'Sessions', icon: SquareTerminal, path: '/sessions' },
  { id: 'jobs', label: 'Jobs', icon: ListChecks, path: '/jobs' },
  { id: 'profiles', label: 'Profiles', icon: UsersRound, path: '/profiles' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
] as const

const COLLAPSED_KEY = 'workerdeck.sidebar-collapsed'

export function AppShell({ children }: { children?: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
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
  return (
    <div className='flex h-dvh bg-sidebar'>
      <aside
        className={cn(
          'flex shrink-0 flex-col gap-1 p-3 transition-[width] duration-150',
          collapsed ? 'w-14 items-center' : 'w-52',
        )}>
        <div className={cn('flex items-center py-2', collapsed ? 'justify-center' : 'gap-2 px-2')}>
          <BrandMark className='size-4 shrink-0 text-fg-1' />
          {!collapsed && (
            <span className='text-body-sm font-semibold tracking-tight text-fg-1'>
              workerdeck
            </span>
          )}
        </div>
        <nav className={cn('mt-1 flex flex-1 flex-col gap-0.5', collapsed && 'items-center')}>
          {NAV.map((item) => {
            const active = pathname.startsWith(item.path)
            return (
              <Link
                key={item.id}
                to={item.path}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                className={cn(
                  'flex items-center rounded-md text-body-sm transition-colors outline-none',
                  collapsed ? 'justify-center p-2' : 'gap-2 px-2 py-1.5',
                  active
                    ? 'bg-surface font-medium text-fg-1 shadow-(--shadow-xs)'
                    : 'text-fg-3 hover:bg-surface-hover hover:text-fg-1',
                )}>
                <item.icon className='size-4 shrink-0' />
                {!collapsed && item.label}
              </Link>
            )
          })}
        </nav>
        <div
          className={cn(
            'flex items-center',
            collapsed ? 'flex-col gap-1' : 'justify-between px-1',
          )}>
          {!collapsed && <span className='font-mono text-label text-fg-4'>v{APP_VERSION}</span>}
          <ThemeToggle />
          <button
            type='button'
            onClick={toggle}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className='flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors outline-none hover:bg-surface-hover hover:text-fg-1'>
            {collapsed ? <PanelLeftOpen className='size-4' /> : <PanelLeftClose className='size-4' />}
          </button>
        </div>
      </aside>
      <main className='frame-shine m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl'>
        {children ?? <Outlet />}
      </main>
    </div>
  )
}
