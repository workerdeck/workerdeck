import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { cn } from '../../lib/utils.ts'

export interface ResponseProps {
  children: string
  streaming?: boolean
  className?: string
}

export const Response = memo(
  function Response({ children, streaming, className }: ResponseProps) {
    return (
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
        shikiTheme={['github-light', 'github-dark']}
        linkSafety={{ enabled: false }}
        className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      >
        {children}
      </Streamdown>
    )
  },
  (prev, next) => prev.children === next.children && prev.streaming === next.streaming && prev.className === next.className,
)
