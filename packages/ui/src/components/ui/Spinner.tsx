import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { useMotionClock } from '../agent/motion-clock.ts'

// The span spins, never the svg: Chromium composites no transform animation on an SVG element at a device scale above 1.
export function Spinner({ className }: { className?: string }) {
  useMotionClock()
  return (
    <span role="img" aria-label="Loading" className={cn('inline-flex size-4 animate-spin text-fg-3', className)}>
      <LoaderCircle aria-hidden className="size-full" />
    </span>
  )
}
