import type { CSSProperties, HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'
import {
  AffordanceProvider,
  resolveAffordances,
  type TerminalAffordances,
} from './affordances.tsx'

/**
 * The root of the terminal theme: the element that establishes the character
 * cell every row inside it lands on.
 *
 * It exists as a component rather than a class because the cell has to be *set*
 * somewhere — the font, the size and the line height together are what make
 * `1ch` mean one column and `--term-line` mean one row — and because that is the
 * one place a host is allowed to change the metrics. Everything below this
 * element measures itself in those two units and never in pixels.
 *
 * The geometry and the palette live in `styles/terminal.css`; this only names
 * the element and hands down the two numbers.
 */
export interface TerminalSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Cell size in **whole pixels**. Fractional values put every other row on a
   * half-pixel: text softens and the diff bands show a seam, which is exactly
   * what a grid renderer must not do. Defaults (13/18) are the CLI's own.
   */
  fontSize?: number
  lineHeight?: number
  /**
   * How far a full-bleed band reaches past the content edge — normally the
   * scroller's own horizontal padding. A band cancels it with matched negative
   * margin and padding, so a diff hunk's wash runs to the viewport edge the way
   * a terminal's line does, instead of stopping at a gutter.
   */
  bleed?: string
  /**
   * The things a real terminal cannot do — the pointer hover fill, the
   * hover-revealed copy actions. `false` turns them all off, an object picks.
   * Default: all on. See {@link TerminalAffordances}; none of them costs layout,
   * so switching them off changes no glyph's position.
   */
  affordances?: TerminalAffordances | boolean
}

export function TerminalSurface({
  fontSize,
  lineHeight,
  bleed,
  affordances,
  className,
  style,
  children,
  ...props
}: TerminalSurfaceProps) {
  const resolved = resolveAffordances(affordances)
  return (
    <div
      data-terminal=''
      // A space-separated list so CSS can ask for one with `~=` — the styling
      // half of the switch, where the JS half (whether a button exists at all)
      // rides the context.
      data-affordances={
        [resolved.hover && 'hover', resolved.actions && 'actions'].filter(Boolean).join(' ') ||
        undefined
      }
      className={cn('min-w-0', className)}
      style={
        {
          ...(fontSize !== undefined && { '--term-font-size': `${Math.round(fontSize)}px` }),
          ...(lineHeight !== undefined && { '--term-line': `${Math.round(lineHeight)}px` }),
          ...(bleed !== undefined && { '--term-bleed': bleed }),
          ...style,
        } as CSSProperties
      }
      {...props}>
      <AffordanceProvider value={resolved}>{children}</AffordanceProvider>
    </div>
  )
}
