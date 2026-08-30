import { memo, type ReactNode } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { cn } from '../../lib/utils.ts'
import { CopyAction, WithActions } from './affordances.tsx'
import { Band } from './row.tsx'

/**
 * Markdown on the character grid: every element mapped onto the theme's own
 * {@link Row}/{@link Band} primitives, never the renderer's prose defaults
 * overridden back off with `!important`. Streamdown keeps only what it alone
 * can do — streaming-safe parsing of half-written markdown.
 *
 * The rendering rules are a terminal's, not a document's: one type size
 * (headings are weight and colour — a bigger glyph would break the grid's one
 * line height), markers are cells (a wrapped line hangs under the text, not
 * the bullet), and code is a band, not a card.
 */

/** Pull the text out of a fenced block's React children (`<code>…</code>`). */
const codeText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(codeText).join('')
  }
  const element = node as { props?: { children?: ReactNode } }
  return element.props ? codeText(element.props.children) : ''
}

/** The language a fence declared, from the `language-*` class on the inner
 * `<code>`. A data attribute only, never highlighted: the CLI does not colour
 * a fenced block inside a message. */
const fenceLanguage = (node: ReactNode): string | undefined => {
  const child = Array.isArray(node) ? node.find(Boolean) : node
  const className = (child as { props?: { className?: string } } | undefined)?.props?.className
  const match = /language-([\w-]+)/.exec(className ?? '')
  return match?.[1]
}

/**
 * A fenced block: a band of dim text with the theme's own copy action —
 * Streamdown's floating copy/download buttons are turned off in its favour
 * (`controls={false}` below).
 */
function CodeBand({ code, language }: { code: string; language?: string }) {
  return (
    <WithActions className="term-block" actions={<CopyAction text={code} label="Copy code" />}>
      <Band className="term-code" data-language={language}>
        <pre className="term-pre">{code}</pre>
      </Band>
    </WithActions>
  )
}

/** Headings differ only in tone — one type size. Return-typed so the
 * parameter picks up the renderer's own component signature. */
const heading = (tone: 'bright' | 'fg'): Components['h1'] =>
  function Heading({ children }) {
    return (
      <div className="term-block" data-tone={tone} data-weight="bold">
        {children}
      </div>
    )
  }

const TERMINAL_COMPONENTS: Components = {
  p: ({ children }) => <div className="term-block">{children}</div>,

  h1: heading('bright'),
  h2: heading('bright'),
  h3: heading('bright'),
  h4: heading('fg'),
  h5: heading('fg'),
  h6: heading('fg'),

  // `term-block` on every block-level output, without exception: the
  // one-blank-line-between-blocks rule keys on it, and a block that forgets it
  // butts straight up against its neighbour.
  ul: ({ children }) => <ul className="term-block term-list">{children}</ul>,
  ol: ({ children }) => <ol className="term-block term-list term-list-ordered">{children}</ol>,
  // The marker is the gutter's `::before`, so a list item is literally a Row:
  // same columns, same hanging indent.
  li: ({ children }) => (
    <li className="term-row term-li">
      <span className="term-gutter" aria-hidden />
      <div className="term-body">{children}</div>
    </li>
  ),

  blockquote: ({ children }) => (
    <blockquote className="term-block term-quote" data-tone="dim">
      {children}
    </blockquote>
  ),

  hr: () => <div className="term-block term-rule" aria-hidden />,

  // `pre` owns the whole fenced block, so the band is built here and `code`
  // never sees a fence.
  pre: ({ children }) => <CodeBand code={codeText(children)} language={fenceLanguage(children)} />,
  code: ({ children }) => (
    <code className="term-inline-code" data-tone="blue">
      {children}
    </code>
  ),

  strong: ({ children }) => (
    <strong data-tone="bright" data-weight="bold">
      {children}
    </strong>
  ),
  em: ({ children }) => <em className="term-em">{children}</em>,
  a: ({ children, href }) => (
    <a className="term-link" data-tone="blue" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),

  // Tables keep the grid by being a grid: monospace cells, one line per row,
  // box-drawing rules instead of borders.
  table: ({ children }) => (
    <div className="term-block term-table-wrap">
      <table className="term-table">{children}</table>
    </div>
  ),
  // Every table element must be mapped: one left on the renderer's padded
  // default puts its rows off the line grid (`td`'s `py-2` → 23px rows in an
  // 18px theme).
  thead: ({ children }) => <thead className="term-thead">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th data-tone="bright" data-weight="bold">
      {children}
    </th>
  ),
  td: ({ children }) => <td>{children}</td>,
}

export interface TerminalMarkdownProps {
  children: string
  /** Streaming text: tolerate half-written markdown (unclosed fences, half links). */
  streaming?: boolean
  className?: string
}

export const TerminalMarkdown = memo(
  function TerminalMarkdown({ children, streaming, className }: TerminalMarkdownProps) {
    return (
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
        // Streamdown's floating copy/download buttons — the theme has its own.
        controls={false}
        components={TERMINAL_COMPONENTS}
        className={cn('term-md', className)}
      >
        {children}
      </Streamdown>
    )
  },
  (prev, next) => prev.children === next.children && prev.streaming === next.streaming && prev.className === next.className,
)
