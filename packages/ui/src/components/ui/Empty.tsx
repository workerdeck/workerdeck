import type { ReactNode } from 'react'
import { Button } from './Button.tsx'

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
    <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
      <div className="text-fg-4 opacity-60 [&_svg]:size-7">{icon}</div>
      <p className="text-body-sm font-medium text-fg-2">{title}</p>
      {description ? <p className="max-w-[26ch] text-balance text-label leading-relaxed text-fg-4">{description}</p> : null}
      {action && onAction ? (
        <Button variant="outline" size="sm" className="mt-1" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  )
}

export function EmptyKey({ children }: { children: ReactNode }) {
  return <span className="rounded border border-border px-1 font-mono text-fg-3">{children}</span>
}
