import { cn } from '../../lib/utils.ts'

export interface ProgressRingProps {
  /** Filled share, 0–100 (clamped). */
  value: number
  /** Outer diameter in px. */
  size?: number
  strokeWidth?: number
  className?: string
}

/** Tiny SVG progress circle; stroke color comes from `currentColor` so callers set it
 * via text color classes (e.g. warning/danger past thresholds). */
export function ProgressRing({ value, size = 13, strokeWidth = 2, className }: ProgressRingProps) {
  const clamped = Math.min(100, Math.max(0, value))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  return (
    <svg
      data-slot="progress-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${Math.round(clamped)}%`}
      className={cn('shrink-0 -rotate-90', className)}
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={strokeWidth} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
      />
    </svg>
  )
}
