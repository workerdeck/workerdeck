import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export interface MessageProps extends HTMLAttributes<HTMLDivElement> {
  from: 'user' | 'assistant'
}

export function Message({ from, className, children, ...props }: MessageProps) {
  return (
    <div data-slot="message" data-from={from} className={cn('flex w-full flex-col items-start gap-1', className)} {...props}>
      {children}
    </div>
  )
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        'min-w-0 text-body-sm leading-6 text-fg-1',
        'in-data-[from=user]:max-w-[85%] in-data-[from=user]:rounded-lg in-data-[from=user]:rounded-bl-sm',
        'in-data-[from=user]:bg-accent-bg in-data-[from=user]:px-3 in-data-[from=user]:py-2',
        'in-data-[from=user]:whitespace-pre-wrap',
        'in-data-[from=assistant]:w-full',
        className,
      )}
      {...props}
    />
  )
}
