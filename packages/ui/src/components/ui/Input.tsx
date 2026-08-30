import { type InputHTMLAttributes, forwardRef } from 'react'
import { cn } from '../../lib/utils.ts'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    data-slot="input"
    className={cn(
      'h-8 w-full rounded-md border border-border bg-bg px-2.5 text-body-sm text-text',
      'placeholder:text-fg-4 transition-colors outline-none',
      'hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
      'disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'
