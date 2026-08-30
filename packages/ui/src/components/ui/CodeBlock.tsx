import type { ReactNode } from 'react'
import { CopyButton } from './CopyButton.tsx'
import { cn } from '../../lib/utils.ts'

export interface CodeBlockProps {
  code: string
  /** Header label, e.g. a language or "Parameters". */
  label?: ReactNode
  copyable?: boolean
  /**
   * `'panel'` (default) is the framed card; `'plain'` is the terminal treatment —
   * dim label line, flat code band, copy as a character. A prop rather than a read
   * of the transcript variant context: a `ui/` primitive knows nothing of transcripts.
   */
  variant?: 'panel' | 'plain'
  className?: string
}

/** Plain (unhighlighted) code panel for structured data like tool inputs. Markdown code
 * inside assistant responses is highlighted by <Response> instead. */
export function CodeBlock({ code, label, copyable = true, variant = 'panel', className }: CodeBlockProps) {
  const plain = variant === 'plain'
  const header = label !== undefined || copyable

  if (plain) {
    return (
      <div data-slot="code-block" data-variant="plain" className={cn('min-w-0', className)}>
        {header ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-label leading-5 text-fg-4">{label}</span>
            {copyable ? <CopyButton glyph value={code} className="size-5 shrink-0 rounded-sm" /> : null}
          </div>
        ) : null}
        <pre className="max-h-64 overflow-auto bg-code-bg px-2 font-mono text-label leading-5 whitespace-pre-wrap text-fg-2">{code}</pre>
      </div>
    )
  }

  return (
    <div data-slot="code-block" className={cn('overflow-hidden rounded-md border border-border bg-code-bg', className)}>
      {header ? (
        <div className="flex h-8 items-center justify-between border-b border-border px-2.5">
          <span className="font-mono text-label text-fg-3">{label}</span>
          {copyable ? <CopyButton value={code} /> : null}
        </div>
      ) : null}
      <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-label whitespace-pre-wrap text-fg-2">{code}</pre>
    </div>
  )
}
