import type { ReactNode } from 'react'
import { Button } from './Button.tsx'

/**
 * A view with nothing in it: icon, title, description, and at most one action.
 *
 * Centered and given room, because an empty view is the first thing a new
 * install shows and a flush-left sentence in the top corner reads like a bug
 * report. It lives here rather than in one client because every panel that can
 * be empty should be empty the same way — the extension's views and the
 * dashboard's four sidebars are the same shape of thing.
 *
 * **At most one action, and never one the view header already offers.** Creating
 * a session and adding a gateway are the `+` in the native title bar, exclusively
 * — so those empty states point at it in words rather than growing a second
 * button that does the same thing two inches lower. A button here is for the way
 * out of a state the header has no answer to: clearing a filter, widening a
 * scope.
 */
export function Empty({
  icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: ReactNode
  title: string
  description?: ReactNode
  action?: string
  onAction?: () => void
}) {
  return (
    <div className='flex flex-col items-center gap-2 px-5 py-8 text-center'>
      <div className='text-fg-4 opacity-60 [&_svg]:size-7'>{icon}</div>
      <p className='text-body-sm font-medium text-fg-2'>{title}</p>
      {description ? (
        <p className='max-w-[26ch] text-balance text-label leading-relaxed text-fg-4'>
          {description}
        </p>
      ) : null}
      {action && onAction ? (
        <Button variant='outline' size='sm' className='mt-1' onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  )
}

/** A key or icon named inline in an empty state's description — "use the + above". */
export function EmptyKey({ children }: { children: ReactNode }) {
  return (
    <span className='rounded border border-border px-1 font-mono text-fg-3'>{children}</span>
  )
}
