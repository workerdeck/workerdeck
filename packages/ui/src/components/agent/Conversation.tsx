import type { HTMLAttributes, ReactNode } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { ArrowDown } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/utils.ts'

export interface ConversationProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode
}

/** Scroll container that stays pinned to the bottom while streaming, unless the user
 * scrolls up — plus a floating scroll-to-bottom button. */
export function Conversation({ className, children, ...props }: ConversationProps) {
  return (
    <StickToBottom
      data-slot='conversation'
      className={cn('relative flex-1 overflow-y-auto', className)}
      initial='instant'
      resize='smooth'
      role='log'
      {...props}>
      {children}
    </StickToBottom>
  )
}

export function ConversationContent({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <StickToBottom.Content
      data-slot='conversation-content'
      className={cn('mx-auto flex w-full max-w-[var(--wd-content-max-w,48rem)] flex-col gap-4 px-4 py-4', className)}
      {...props}>
      {children}
    </StickToBottom.Content>
  )
}

export function ConversationScrollButton({ className }: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return (
    <Button
      variant='outline'
      size='icon'
      aria-label='Scroll to bottom'
      data-slot='conversation-scroll-button'
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-(--shadow-md)',
        className,
      )}
      onClick={() => void scrollToBottom()}>
      <ArrowDown className='size-4' />
    </Button>
  )
}
