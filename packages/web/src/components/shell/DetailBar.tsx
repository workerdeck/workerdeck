import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

export type Crumb = {
  label: string
  // Absent on the last crumb, which is where you already are.
  to?: string
}

export function DetailBar({ crumbs, actions, children }: { crumbs: Crumb[]; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
        {crumbs.map((crumb, index) => (
          <span key={crumb.label} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight aria-hidden className="size-3 shrink-0 text-fg-4" /> : null}
            {crumb.to ? (
              <Link to={crumb.to} className="shrink-0 text-body-sm text-fg-3 outline-none hover:text-fg-1">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="min-w-0 truncate text-body-sm font-medium text-fg-1" title={crumb.label}>
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      {children}
      <span className="flex-1" />
      {actions}
    </div>
  )
}

export function DetailBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">{children}</div>
    </div>
  )
}

/** One label/value line inside a {@link DetailBody} — the detail pages' only row shape. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-label font-medium text-fg-3">{label}</span>
      <span className="min-w-0 text-right text-body-sm text-fg-1">{children}</span>
    </div>
  )
}
