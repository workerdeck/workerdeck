import { type HTMLAttributes } from 'react'
import { type VariantProps, cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-label font-medium whitespace-nowrap', {
  variants: {
    variant: {
      neutral: 'border-border bg-surface text-fg-2',
      accent: 'border-transparent bg-accent-bg text-fg-1',
      success: 'border-transparent bg-success-bg text-success',
      warning: 'border-transparent bg-warning-bg text-warning',
      danger: 'border-transparent bg-danger-bg text-danger',
      info: 'border-transparent bg-info-bg text-info',
    },
    mono: {
      true: 'font-mono text-code',
      false: '',
    },
  },
  defaultVariants: { variant: 'neutral', mono: false },
})

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Render a leading status dot in the variant's color. */
  dot?: boolean
}

export function Badge({ className, variant = 'neutral', mono, dot, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant, mono, className }))} {...props}>
      {/* `self-center` so the dot stays put if a caller baseline-aligns the
          badge — a no-op under the default `items-center`, and what lets the
          badge's *text* be the baseline it contributes to a row (a status bar
          aligning readings on one line needs that, and the dot's own box would
          otherwise answer for it). */}
      {dot ? <span aria-hidden className="size-1.5 shrink-0 self-center rounded-full bg-current" /> : null}
      {children}
    </span>
  )
}

export { badgeVariants }
