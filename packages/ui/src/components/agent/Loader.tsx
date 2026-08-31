import { cn } from '../../lib/utils.ts'

export interface LoaderProps {
  label?: string
  startedAt?: number
  tokens?: number
  className?: string
}

export function Loader({ label, className }: LoaderProps) {
  return (
    <div data-slot="loader" className={cn('flex items-center gap-2 py-1 text-body-sm text-fg-4', className)}>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 animate-pulse rounded-full bg-fg-4" style={{ animationDelay: `${i * 160}ms` }} />
        ))}
      </span>
      {label ? <span>{label}</span> : null}
    </div>
  )
}
