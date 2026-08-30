import { type TextareaHTMLAttributes, forwardRef } from 'react'
import { cn } from '../../lib/utils.ts'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn(
      'w-full resize-none rounded-md border border-border bg-bg px-2.5 py-2 text-body-sm text-text',
      'placeholder:text-fg-4 transition-colors outline-none',
      'hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
      'disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
