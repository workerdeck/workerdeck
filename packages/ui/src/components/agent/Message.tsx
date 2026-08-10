import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'
import { LINE_TEXT, LineGlyph, useLines } from './transcript-variant.tsx'

export interface MessageProps extends HTMLAttributes<HTMLDivElement> {
  from: 'user' | 'assistant'
}

/**
 * One chat turn row.
 *
 * `cards`: user messages sit right in a bubble; assistant content is flat,
 * full-width (the AI-chat convention — assistant output is the page, user input
 * is quoted).
 *
 * `lines`: both are left-aligned full-width line items behind a gutter glyph —
 * `❯` for what was typed, `●` for what the model said. No bubble: a prompt is
 * already distinguishable by its marker, and the bubble's padding is vertical
 * space the terminal treatment refuses to spend.
 */
export function Message({ from, className, children, ...props }: MessageProps) {
  const lines = useLines()
  return (
    <div
      data-slot='message'
      data-from={from}
      className={cn(
        'flex w-full',
        lines
          ? cn(
              'flex-row gap-2',
              // What YOU said, on a band of its own — the CLI's own treatment.
              // Full-bleed (the negative margin cancels the row's padding) so
              // the band lines up with the hover highlight rather than sitting
              // inside it, and square-ish so it reads as a strip, not a bubble.
              from === 'user' && '-mx-1 rounded-sm bg-surface px-1',
            )
          : cn('flex-col gap-1', from === 'user' ? 'items-end' : 'items-start'),
        className,
      )}
      {...props}>
      {lines ? (
        <>
          <LineGlyph className={from === 'user' ? 'text-accent' : 'text-fg-3'}>
            {from === 'user' ? '❯' : '●'}
          </LineGlyph>
          <div className='flex min-w-0 flex-1 flex-col gap-1'>{children}</div>
        </>
      ) : (
        children
      )}
    </div>
  )
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const lines = useLines()
  return (
    <div
      data-slot='message-content'
      className={cn(
        'min-w-0',
        lines
          ? cn('w-full text-fg-1', LINE_TEXT, 'in-data-[from=user]:whitespace-pre-wrap')
          : cn(
              'text-body-sm leading-6 text-fg-1',
              // Bubble treatment only within a user message row.
              'in-data-[from=user]:max-w-[85%] in-data-[from=user]:rounded-lg in-data-[from=user]:rounded-br-sm',
              'in-data-[from=user]:bg-accent-bg in-data-[from=user]:px-3 in-data-[from=user]:py-2',
              'in-data-[from=user]:whitespace-pre-wrap',
              'in-data-[from=assistant]:w-full',
            ),
        className,
      )}
      {...props}
    />
  )
}
