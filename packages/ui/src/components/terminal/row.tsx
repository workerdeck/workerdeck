/**
 * The primitives every terminal row is built from — the whole vocabulary:
 * {@link Row} (gutter cell + body cell), {@link Blank} (one empty line),
 * {@link Band} (a run of rows under a full-bleed background). Geometry is in
 * `styles/terminal.css`; these choose a class, a marker and a tone, never a
 * measurement.
 */

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

/** The palette, as a name. See the `[data-tone]` rules in `terminal.css`. */
export type Tone = 'fg' | 'bright' | 'dim' | 'faint' | 'mark' | 'blue' | 'green' | 'red' | 'yellow' | 'magenta'

export interface RowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * What sits in the gutter — `●`, `⎿`, `>`, a list bullet, or nothing. Must
   * fit the gutter width (`--term-cell`, two columns by default) or it pushes
   * the body off the shared column. Omitted, the gutter still occupies space.
   */
  glyph?: ReactNode
  /** The marker's colour. Defaults to dim — the marker is structure, not content. */
  glyphTone?: Tone
  /** The body's colour. */
  tone?: Tone
  bold?: boolean
  /** Indent levels, one character cell each. A child row's marker then sits
   * exactly under its parent row's first letter. */
  indent?: 0 | 1 | 2 | 3
  /**
   * Gutter width in columns when the marker needs other than two (an ordered
   * list's `10.` is four, a framed payload wants `0`). Changes only this row's
   * split; the body still starts on a whole column.
   */
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
      // `!== undefined`, not truthiness: `columns={0}` is a real request for a
      // gutterless row (a framed payload) and must not fall back to the default.
      style={columns === undefined ? style : ({ ...style, '--term-cell': `${columns}ch` } as CSSProperties)}
      {...props}
    >
      <span className="term-gutter" data-tone={glyphTone} aria-hidden>
        {glyph ?? ' '}
      </span>
      {/* A div, not a span: a body holds block content (a markdown message, a
          band of output) as often as it holds a line of text. */}
      <div className="term-body">{children}</div>
    </div>
  )
}

/**
 * One empty line — the theme's only vertical spacing. Spacing is part of the
 * row list, decided by whoever knows whether two blocks belong together, never
 * by a margin rule.
 */
export function Blank() {
  return <div className="term-blank" aria-hidden />
}

/**
 * A run of rows under a background: a code block, a command's output, a diff
 * hunk. Full-bleed via `--term-bleed` on {@link TerminalSurface}.
 */
export function Band({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('term-band', className)} {...props} />
}

/** Inline colour/weight inside a row's body. */
export function Ink({ tone, bold, className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; bold?: boolean }) {
  return <span data-tone={tone} data-weight={bold ? 'bold' : undefined} className={className} {...props} />
}
