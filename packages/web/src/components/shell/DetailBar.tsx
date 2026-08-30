import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

export type Crumb = {
  label: string
  /** Absent on the last crumb — it is where you already are. */
  to?: string
}

/**
 * The top bar every detail page wears: breadcrumbs on the left, the page's own
 * actions on the right.
 *
 * The session view has had one since it was the only detail page, and the other
 * three grew their own headings *inside* the scroll area instead — which meant
 * the thing telling you where you were scrolled away, and each page put its
 * actions somewhere slightly different. This is that bar, shared.
 *
 * The first crumb links back to the section even though its list is right there
 * in the sidebar and never left. That is deliberate: it names the section, which
 * is what a breadcrumb is for, and clicking it clears the selection — the one
 * thing the sidebar cannot do for you.
 */
export function DetailBar({
  crumbs,
  actions,
  children,
}: {
  crumbs: Crumb[]
  /** Buttons at the right end of the bar. */
  actions?: ReactNode
  /** Anything between the crumbs and the actions — a status badge, a path. */
  children?: ReactNode
}) {
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

/** The scrolling body under a {@link DetailBar} — the column width every detail
 * page shares, so three pages don't each pick their own measure. */
export function DetailBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">{children}</div>
    </div>
  )
}
