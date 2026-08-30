import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

/**
 * The primitives every terminal row is built from.
 *
 * There are three, and that is the whole vocabulary: a {@link Row} (a gutter
 * cell and a body cell), a {@link Blank} (one empty line), and a {@link Band} (a
 * run of rows carrying a full-bleed background). Anything the theme draws — a
 * message, a tool call, a diff hunk, an approval prompt — is some arrangement of
 * those, which is what keeps the grid a property of the renderer rather than a
 * thing each component re-derives.
 *
 * Geometry is in `styles/terminal.css`. These components choose a class, a
 * marker and a tone; they never carry a measurement.
 */

/** The palette, as a name. See the `[data-tone]` rules in `terminal.css`. */
export type Tone = 'fg' | 'bright' | 'dim' | 'faint' | 'mark' | 'blue' | 'green' | 'red' | 'yellow' | 'magenta'

export interface RowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * What sits in the gutter — `●`, `⎿`, `>`, a list bullet, or nothing. Kept to
   * the width of the gutter (`--term-cell`, two columns by default): a wider
   * marker would push its own body off the column every other row starts on.
   * Omitted, the gutter is still drawn as empty space, so an unmarked row's
   * text lines up with a marked one's.
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
   * Gutter width in columns, when the marker needs other than two — an ordered
   * list's `10.` is four, a prompt's `❯ 1.` is five, and a framed payload wants
   * `0`. Changes only this row's split, so the body still starts on a whole
   * column.
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
 * One empty line — the theme's only vertical spacing.
 *
 * A terminal separates blocks with a blank line, not with padding, and saying it
 * that way has a practical payoff: spacing is part of the row list, so it can be
 * decided by whoever knows whether two blocks belong together (a tool call and
 * its output do not get one; two assistant turns do), instead of by a margin
 * rule that cannot tell them apart.
 */
export function Blank() {
  return <div className="term-blank" aria-hidden />
}

/**
 * A run of rows under a background: a code block, a command's output, a diff
 * hunk. Full-bleed — the wash reaches the scroller's edges, because in a
 * terminal the line is the full width of the screen. See `--term-bleed` on
 * {@link TerminalSurface}.
 */
export function Band({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('term-band', className)} {...props} />
}

/** Inline colour/weight inside a row's body. */
export function Ink({ tone, bold, className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; bold?: boolean }) {
  return <span data-tone={tone} data-weight={bold ? 'bold' : undefined} className={className} {...props} />
}
