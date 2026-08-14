import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export interface MessageProps extends HTMLAttributes<HTMLDivElement> {
  from: 'user' | 'assistant'
}

/**
 * One chat turn row.
 *
 * `cards`: user messages sit in a bubble, assistant content is flat and
 * full-width. Both are **left-aligned**: the transcript is a log read top to
 * bottom, and an editor-shaped host (a full-width session view beside a sessions
 * rail) has no right edge to anchor to — a bubble drifting right in a 1600px
 * column separates a prompt from the reply it produced. The bubble alone is
 * enough to say who spoke.
 *
 * The terminal theme draws none of this: it is its own renderer
 * (`components/terminal/`) and mounts instead of these rows.
 */
export function Message({ from, className, children, ...props }: MessageProps) {
  return (
    <div
      data-slot='message'
      data-from={from}
      className={cn('flex w-full flex-col items-start gap-1', className)}
      {...props}>
      {children}
    </div>
  )
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot='message-content'
      className={cn(
        'min-w-0 text-body-sm leading-6 text-fg-1',
        // Bubble treatment only within a user message row.
        // The tail points bottom-*left* now that the bubble is left-aligned.
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
