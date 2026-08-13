import { memo, type ReactNode } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { cn } from '../../lib/utils.ts'
import { CopyAction, WithActions } from './affordances.tsx'
import { Band } from './row.tsx'

/**
 * Markdown on the character grid.
 *
 * The `lines` variant did this by letting the renderer draw its prose defaults
 * and then overriding roughly sixty declarations back off with `!important` —
 * every margin, every list gap, the fenced-code card's four nested boxes, the
 * table's frame and its floating button pill. That is a losing position by
 * construction: each renderer upgrade is a new set of boxes to find and unpaint,
 * and the CSS says what the output must *not* look like rather than what it is.
 *
 * So this maps the elements instead. Streamdown keeps what only it can do —
 * streaming-safe parsing of half-written markdown — and every block it emits is
 * built from the same {@link Row}/{@link Band} primitives the rest of the theme
 * uses. There is no `!important` here and there is no CSS fighting anything.
 *
 * The rendering rules are a terminal's, not a document's:
 *
 * - **One type size.** Headings are weight and colour; a bigger glyph would
 *   break the only line height the grid has.
 * - **Markers are cells.** A bullet is `- ` (two columns), an ordered marker
 *   `1. ` (three), and the text starts on the next column exactly as it does in
 *   the markdown source — so a wrapped line hangs under the text, not the
 *   bullet, and nesting costs one marker width per level.
 * - **Code is a band, not a card.** No frame, no language strip, no floating
 *   buttons: a fenced block is a wash of dim text running to the screen edge,
 *   which is what a terminal shows.
 */

/** Pull the text out of a fenced block's React children (`<code>…</code>`). */
function codeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(codeText).join('')
  const element = node as { props?: { children?: ReactNode } }
  return element.props ? codeText(element.props.children) : ''
}

/** The language a fence declared, from the `language-*` class react-markdown
 * puts on the inner `<code>`. Kept as a data attribute rather than used to
 * highlight: the CLI does not colour a fenced block inside a message, and a
 * second highlighter here would be a second theme to keep in sync. */
function fenceLanguage(node: ReactNode): string | undefined {
  const child = Array.isArray(node) ? node.find(Boolean) : node
  const className = (child as { props?: { className?: string } } | undefined)?.props?.className
  const match = /language-([\w-]+)/.exec(className ?? '')
  return match?.[1]
}

/**
 * A fenced block: a band of dim text, and the one place a copy affordance earns
 * its keep most — a command in a message is there to be run.
 *
 * The renderer's own copy/download buttons are turned off (`controls={false}`)
 * in favour of this: they are web buttons floating over the content in another
 * application's idiom, and they are not switchable by the surface the way
 * everything else here is.
 */
function CodeBand({ code, language }: { code: string; language?: string }) {
  return (
    <WithActions className='term-block' actions={<CopyAction text={code} label='Copy code' />}>
      <Band className='term-code' data-language={language}>
        <pre className='term-pre'>{code}</pre>
      </Band>
    </WithActions>
  )
}

/** Headings differ only in tone — a terminal has one type size, so `h1` and `h4`
 * cannot differ in anything else. Return-typed so the parameter picks up the
 * renderer's own component signature rather than a narrower hand-written one. */
const heading = (tone: 'bright' | 'fg'): Components['h1'] =>
  function Heading({ children }) {
    return (
      <div className='term-block' data-tone={tone} data-weight='bold'>
        {children}
      </div>
    )
  }

const TERMINAL_COMPONENTS: Components = {
  p: ({ children }) => <div className='term-block'>{children}</div>,

  h1: heading('bright'),
  h2: heading('bright'),
  h3: heading('bright'),
  h4: heading('fg'),
  h5: heading('fg'),
  h6: heading('fg'),

  // `term-block` on every block-level output, without exception: it is what the
  // one-blank-line-between-blocks rule keys on, and a block that forgets it butts
  // straight up against its neighbour (a list running into the paragraph after
  // it, which is exactly how this was found).
  ul: ({ children }) => <ul className='term-block term-list'>{children}</ul>,
  ol: ({ children }) => <ol className='term-block term-list term-list-ordered'>{children}</ol>,
  // The marker is the gutter's `::before` (a CSS counter for the ordered case),
  // so a list item is literally a Row: same two columns, same hanging indent,
  // and a nested list inside the body indents by exactly one marker width.
  li: ({ children }) => (
    <li className='term-row term-li'>
      <span className='term-gutter' aria-hidden />
      <div className='term-body'>{children}</div>
    </li>
  ),

  blockquote: ({ children }) => (
    <blockquote className='term-block term-quote' data-tone='dim'>
      {children}
    </blockquote>
  ),

  hr: () => <div className='term-block term-rule' aria-hidden />,

  // Fenced code. `pre` owns the whole block — the inner `<code>` is only where
  // the text and the language live — so the band is built here and `code` never
  // sees a fence.
  pre: ({ children }) => <CodeBand code={codeText(children)} language={fenceLanguage(children)} />,
  code: ({ children }) => (
    <code className='term-inline-code' data-tone='blue'>
      {children}
    </code>
  ),

  strong: ({ children }) => (
    <strong data-tone='bright' data-weight='bold'>
      {children}
    </strong>
  ),
  em: ({ children }) => <em className='term-em'>{children}</em>,
  a: ({ children, href }) => (
    <a className='term-link' data-tone='blue' href={href} target='_blank' rel='noreferrer'>
      {children}
    </a>
  ),

  // Tables keep the grid by being a grid: monospace cells, one line per row, and
  // dim box-drawing rules instead of borders that would land between cells.
  table: ({ children }) => (
    <div className='term-block term-table-wrap'>
      <table className='term-table'>{children}</table>
    </div>
  ),
  // Every table element, and not just the ones that looked wrong: any element
  // left unmapped keeps the renderer's own padded, bordered default, and a
  // single one of those puts its rows off the line grid (`td`'s `py-2` was
  // making table rows 23px in an 18px theme).
  thead: ({ children }) => <thead className='term-thead'>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th data-tone='bright' data-weight='bold'>
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
        // The renderer's copy/download affordances are web buttons floating over
        // the content. A terminal has none, and the transcript's own selection
        // is how you copy from one.
        controls={false}
        components={TERMINAL_COMPONENTS}
        className={cn('term-md', className)}>
        {children}
      </Streamdown>
    )
  },
  (prev, next) =>
    prev.children === next.children &&
    prev.streaming === next.streaming &&
    prev.className === next.className,
)
