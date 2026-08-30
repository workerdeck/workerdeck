import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-label="Loading" className={cn('size-4 animate-spin text-fg-3', className)} />
}
