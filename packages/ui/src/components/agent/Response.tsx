import { memo } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { cn } from '../../lib/utils.ts'
import { MARKDOWN_REHYPE_PLUGINS, MarkdownImage } from './markdown-image.tsx'

const COMPONENTS: Components = {
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
}

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
        components={COMPONENTS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      >
        {children}
      </Streamdown>
    )
  },
  (prev, next) => prev.children === next.children && prev.streaming === next.streaming && prev.className === next.className,
)
