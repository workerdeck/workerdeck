import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

export type Tone = 'fg' | 'bright' | 'dim' | 'faint' | 'mark' | 'blue' | 'green' | 'red' | 'yellow' | 'magenta'

export interface RowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  glyph?: ReactNode
  glyphTone?: Tone
  tone?: Tone
  bold?: boolean
  indent?: 0 | 1 | 2 | 3
  columns?: number
  children?: ReactNode
}

export function Row({ glyph, glyphTone, tone, bold, indent, columns, className, children, style, ...props }: RowProps) {
  return (
    <div
      className={cn('term-row', className)}
      data-indent={indent ? String(indent) : undefined}
      data-tone={tone}
      data-weight={bold ? 'bold' : undefined}
      // `!== undefined`, not truthiness: `columns={0}` is a real request for a gutterless row.
      style={columns === undefined ? style : ({ ...style, '--term-cell': `${columns}ch` } as CSSProperties)}
      {...props}
    >
      <span className="term-gutter" data-tone={glyphTone} aria-hidden>
        {glyph ?? ' '}
      </span>
      <div className="term-body">{children}</div>
    </div>
  )
}

export function Blank() {
  return <div className="term-blank" aria-hidden />
}

export function Band({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('term-band', className)} {...props} />
}

export function Ink({ tone, bold, className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; bold?: boolean }) {
  return <span data-tone={tone} data-weight={bold ? 'bold' : undefined} className={className} {...props} />
}
