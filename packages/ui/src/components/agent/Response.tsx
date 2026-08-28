import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { cn } from '../../lib/utils.ts'

export interface ResponseProps {
  children: string
  /** Streaming text: tolerate incomplete markdown (unclosed fences, half links). */
  streaming?: boolean
  className?: string
}

/** Markdown renderer for assistant output — streaming-safe via streamdown, code
 * highlighted with shiki (dual theme follows [data-theme] through the dark: variant). */
export const Response = memo(
  function Response({ children, streaming, className }: ResponseProps) {
    return (
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
        shikiTheme={['github-light', 'github-dark']}
        // Link safety is handled at the panel level — VS Code's native
        // webview handler, the browser's `target="_blank"`, or the
        // embedder's `onLinkClick` prop — not by Streamdown's own modal.
        linkSafety={{ enabled: false }}
        className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}>
        {children}
      </Streamdown>
    )
  },
  (prev, next) =>
    prev.children === next.children && prev.streaming === next.streaming && prev.className === next.className,
)
