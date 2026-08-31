import type { CSSProperties, HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'
import { AffordanceProvider, resolveAffordances, type TerminalAffordances } from './affordances.tsx'

export interface TerminalSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  fontSize?: number
  lineHeight?: number
  bleed?: string
  affordances?: TerminalAffordances | boolean
}

export function TerminalSurface({ fontSize, lineHeight, bleed, affordances, className, style, children, ...props }: TerminalSurfaceProps) {
  const resolved = resolveAffordances(affordances)
  return (
    <div
      data-terminal=""
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
