import { memo, type ReactNode } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { cn } from '../../lib/utils.ts'
import { CopyAction, WithActions } from './affordances.tsx'
import { Band } from './row.tsx'

function codeText(node: ReactNode): string {
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

function fenceLanguage(node: ReactNode): string | undefined {
  const child = Array.isArray(node) ? node.find(Boolean) : node
  const className = (child as { props?: { className?: string } } | undefined)?.props?.className
  const match = /language-([\w-]+)/.exec(className ?? '')
  return match?.[1]
}

function CodeBand({ code, language }: { code: string; language?: string }) {
  return (
    <WithActions className="term-block" actions={<CopyAction text={code} label="Copy code" />}>
      <Band className="term-code" data-language={language}>
        <pre className="term-pre">{code}</pre>
      </Band>
    </WithActions>
  )
}

function heading(tone: 'bright' | 'fg'): Components['h1'] {
  return function Heading({ children }) {
    return (
      <div className="term-block" data-tone={tone} data-weight="bold">
        {children}
      </div>
    )
  }
}

const TERMINAL_COMPONENTS: Components = {
  p: ({ children }) => <div className="term-block">{children}</div>,

  h1: heading('bright'),
  h2: heading('bright'),
  h3: heading('bright'),
  h4: heading('fg'),
  h5: heading('fg'),
  h6: heading('fg'),

  ul: ({ children }) => <ul className="term-block term-list">{children}</ul>,
  ol: ({ children }) => <ol className="term-block term-list term-list-ordered">{children}</ol>,
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

  table: ({ children }) => (
    <div className="term-block term-table-wrap">
      <table className="term-table">{children}</table>
    </div>
  ),
  // Every table element must be mapped: an unmapped `td` keeps its `py-2` and puts rows off the line grid (23px in an 18px theme).
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
  streaming?: boolean
  className?: string
}

export const TerminalMarkdown = memo(
  function TerminalMarkdown({ children, streaming, className }: TerminalMarkdownProps) {
    return (
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown={streaming}
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
