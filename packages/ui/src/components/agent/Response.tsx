import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { cn } from '../../lib/utils.ts'
import { useLines } from './transcript-variant.tsx'

/**
 * Markdown on a terminal's grid.
 *
 * Prose defaults give every block its own rhythm — a heading is bigger, a list
 * item is looser, an inline `code` chip is padded taller than the line it sits
 * in — and the result is text that visibly breathes at different rates as you
 * scroll. A terminal has exactly one line height and one type size, and that
 * uniformity is most of what makes it readable at a glance.
 *
 * So: every line 1.25rem, every block flush, and one blank line (1.25rem, i.e.
 * exactly one row) between blocks. Headings keep their weight but lose their
 * size. Inline code keeps a background — it still has to be distinguishable —
 * but no vertical padding, because that is what pushes a line off the grid.
 */
const TERMINAL_PROSE = [
  'text-body-sm leading-5',
  '[&_*]:leading-5',
  // Block rhythm: nothing has its own margins, and siblings are one row apart.
  // `!` throughout because these fight the renderer's own utilities, and some of
  // those (`space-y-*`, which is a `> * + *` rule) outrank a plain descendant
  // selector — a list would otherwise keep its half-row gaps while every other
  // block snapped to the grid.
  '[&_p]:my-0! [&_pre]:my-0! [&_blockquote]:my-0! [&_table]:my-0!',
  '[&_h1]:my-0! [&_h2]:my-0! [&_h3]:my-0! [&_h4]:my-0! [&_h5]:my-0! [&_h6]:my-0!',
  '[&>*+*]:mt-5',
  // Lists are rows, not paragraphs: no margin anywhere in them, and no
  // inter-item spacing from a `space-y` on the list itself.
  '[&_ul]:my-0! [&_ol]:my-0! [&_li]:my-0! [&_li>p]:my-0!',
  '[&_li+li]:mt-0! [&_ul_ul]:mt-0! [&_ul_ol]:mt-0! [&_ol_ul]:mt-0! [&_ol_ol]:mt-0!',
  '[&_li]:py-0! [&_ul]:py-0! [&_ol]:py-0!',
  // Markers on their own column, at the width the marker actually is — the
  // indent a terminal (and the markdown source) uses, not a typographic one.
  // `ch` is the unit because this variant runs in a monospace face: `• ` is two
  // cells, `1. ` is three, so the text starts exactly where it would in the raw
  // document and a wrapped line hangs under it instead of under the bullet.
  // Nesting then costs one marker width per level, which is the 2-space step.
  // `list-outside` is the load-bearing half: the renderer marks lists `inside`,
  // where the marker joins the text flow — so the indent moves the bullet too
  // (the list sits a marker-width right of the paragraph above it) and a wrapped
  // line runs back under the bullet instead of hanging under its own text.
  '[&_ul]:list-outside! [&_ol]:list-outside!',
  '[&_ul]:pl-[2ch]! [&_ol]:pl-[3ch]! [&_li]:pl-0!',
  // Headings are weight, not size — a terminal has one type size.
  '[&_h1]:text-body-sm [&_h2]:text-body-sm [&_h3]:text-body-sm',
  '[&_h4]:text-body-sm [&_h5]:text-body-sm [&_h6]:text-body-sm',
  '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
  '[&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold',
  '[&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-2',
  // Inline code only (`:not(pre) > code`) — fenced blocks keep their own box.
  // Horizontal padding is free; vertical padding is what pushes a line off grid.
  '[&_:not(pre)>code]:rounded-none [&_:not(pre)>code]:px-1! [&_:not(pre)>code]:py-0!',
  '[&_:not(pre)>code]:text-body-sm [&_:not(pre)>code]:leading-5! [&_:not(pre)>code]:text-fg-1',
  '[&_th]:py-0! [&_td]:py-0!',
  // The renderer's fenced-code card: rounded frame, its own header strip, a
  // second rounded frame inside it, and a floating pill for the buttons. Four
  // boxes around what is, in a terminal, a band of dim text. Flattened to
  // exactly that — the band keeps a background so a block still reads as code,
  // and the actions keep their top-right corner but lose the pill.
  '[&_[data-streamdown=code-block]]:my-0! [&_[data-streamdown=code-block]]:gap-0!',
  '[&_[data-streamdown=code-block]]:rounded-none! [&_[data-streamdown=code-block]]:border-0!',
  '[&_[data-streamdown=code-block]]:bg-transparent! [&_[data-streamdown=code-block]]:p-0!',
  // The language strip costs a whole row to say what the code already shows, and
  // the actions cost another. Both go: the block is the band, and the buttons
  // float over its top-right corner, appearing on hover or keyboard focus.
  '[&_[data-streamdown=code-block]]:relative!',
  '[&_[data-streamdown=code-block-header]]:hidden!',
  '[&_div:has(>[data-streamdown=code-block-actions])]:absolute! [&_div:has(>[data-streamdown=code-block-actions])]:top-0!',
  '[&_div:has(>[data-streamdown=code-block-actions])]:right-0! [&_div:has(>[data-streamdown=code-block-actions])]:mt-0!',
  '[&_div:has(>[data-streamdown=code-block-actions])]:h-5! [&_div:has(>[data-streamdown=code-block-actions])]:opacity-0!',
  '[&_div:has(>[data-streamdown=code-block-actions])]:transition-opacity',
  '[&_[data-streamdown=code-block]:hover_div:has(>[data-streamdown=code-block-actions])]:opacity-100!',
  '[&_[data-streamdown=code-block]:focus-within_div:has(>[data-streamdown=code-block-actions])]:opacity-100!',
  '[&_[data-streamdown=code-block-actions]]:rounded-none! [&_[data-streamdown=code-block-actions]]:border-0!',
  '[&_[data-streamdown=code-block-actions]]:bg-code-bg! [&_[data-streamdown=code-block-actions]]:px-1!',
  '[&_[data-streamdown=code-block-actions]]:py-0! [&_[data-streamdown=code-block-actions]]:gap-1!',
  '[&_[data-streamdown=code-block-actions]]:backdrop-blur-none!',
  '[&_[data-streamdown=code-block-body]]:rounded-none! [&_[data-streamdown=code-block-body]]:border-0!',
  '[&_[data-streamdown=code-block-body]]:bg-code-bg! [&_[data-streamdown=code-block-body]]:px-2!',
  '[&_[data-streamdown=code-block-body]]:py-0! [&_[data-streamdown=code-block-body]]:text-body-sm!',
  // The action buttons' hit areas, on the grid like everything else.
  '[&_[data-streamdown=code-block-copy-button]]:p-0! [&_[data-streamdown=code-block-download-button]]:p-0!',
  // Tables come in a frame of their own, plus a controls row above them and a
  // second frame around the scroller — three boxes and a blank line to hold
  // three buttons. Same treatment: the table is the content, the buttons float
  // over its top-right on hover. The controls row is the child that has no
  // `<table>` in it, which is also how it knows to disappear when the renderer
  // draws no controls at all.
  '[&_[data-streamdown=table-wrapper]]:rounded-none! [&_[data-streamdown=table-wrapper]]:border-0!',
  '[&_[data-streamdown=table-wrapper]]:my-0! [&_[data-streamdown=table-wrapper]]:bg-transparent!',
  '[&_[data-streamdown=table-wrapper]]:relative! [&_[data-streamdown=table-wrapper]]:gap-0!',
  '[&_[data-streamdown=table-wrapper]]:p-0!',
  '[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:absolute! [&_[data-streamdown=table-wrapper]>div:not(:has(table))]:top-0!',
  '[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:right-0! [&_[data-streamdown=table-wrapper]>div:not(:has(table))]:z-10!',
  '[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:opacity-0! [&_[data-streamdown=table-wrapper]>div:not(:has(table))]:bg-code-bg!',
  '[&_[data-streamdown=table-wrapper]>div:not(:has(table))]:px-1! [&_[data-streamdown=table-wrapper]>div:not(:has(table))]:transition-opacity',
  '[&_[data-streamdown=table-wrapper]:hover>div:not(:has(table))]:opacity-100!',
  '[&_[data-streamdown=table-wrapper]:focus-within>div:not(:has(table))]:opacity-100!',
  '[&_[data-streamdown=table-wrapper]>div:has(table)]:rounded-none! [&_[data-streamdown=table-wrapper]>div:has(table)]:border-0!',
  '[&_[data-streamdown=table-wrapper]>div:has(table)]:bg-transparent!',
].join(' ')

/**
 * The controls' icons as characters.
 *
 * The renderer draws its copy/download affordances as line-art SVGs, which next
 * to monospace text read as buttons from another application. These are the
 * glyphs a terminal would use — and they inherit the surrounding font, so they
 * sit on the same grid as the code they belong to.
 */
const glyphIcon = (glyph: string) =>
  function GlyphIcon({ className }: { className?: string }) {
    return (
      <span aria-hidden className={cn('font-mono text-body-sm leading-5', className)}>
        {glyph}
      </span>
    )
  }

const TERMINAL_ICONS = {
  DownloadIcon: glyphIcon('⤓'),
  CopyIcon: glyphIcon('⧉'),
  CheckIcon: glyphIcon('✓'),
}

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
    const lines = useLines()
    return (
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
        shikiTheme={['github-light', 'github-dark']}
        icons={lines ? TERMINAL_ICONS : undefined}
        className={cn(
          'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          lines && TERMINAL_PROSE,
          className,
        )}>
        {children}
      </Streamdown>
    )
  },
  (prev, next) =>
    prev.children === next.children && prev.streaming === next.streaming && prev.className === next.className,
)
