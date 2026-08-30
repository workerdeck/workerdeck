import type { CSSProperties, HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'
import { AffordanceProvider, resolveAffordances, type TerminalAffordances } from './affordances.tsx'

/**
 * The root of the terminal theme: establishes the character cell (`1ch` column,
 * `--term-line` row) and is the one place a host may change the metrics.
 * Everything below measures itself in those two units, never in pixels.
 * Geometry and palette live in `styles/terminal.css`.
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
   * scroller's own horizontal padding, cancelled with matched negative margin
   * and padding so a band's wash runs to the viewport edge.
   */
  bleed?: string
  /**
   * The things a real terminal cannot do (hover fill, hover-revealed copy
   * actions). `false` turns them all off, an object picks; default all on.
   * None costs layout, so switching them off moves no glyph.
   */
  affordances?: TerminalAffordances | boolean
}

export function TerminalSurface({ fontSize, lineHeight, bleed, affordances, className, style, children, ...props }: TerminalSurfaceProps) {
  const resolved = resolveAffordances(affordances)
  return (
    <div
      data-terminal=""
      // Space-separated so CSS can ask for one flag with `~=`.
      data-affordances={[resolved.hover && 'hover', resolved.actions && 'actions'].filter(Boolean).join(' ') || undefined}
      className={cn('min-w-0', className)}
      style={
        {
          ...(fontSize !== undefined && { '--term-font-size': `${Math.round(fontSize)}px` }),
          ...(lineHeight !== undefined && { '--term-line': `${Math.round(lineHeight)}px` }),
          ...(bleed !== undefined && { '--term-bleed': bleed }),
          ...style,
        } as CSSProperties
      }
      {...props}
    >
      <AffordanceProvider value={resolved}>{children}</AffordanceProvider>
    </div>
  )
}
