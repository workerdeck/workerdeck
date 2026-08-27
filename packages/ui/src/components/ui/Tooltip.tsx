import { type FunctionComponent, type ReactElement, type ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '../../lib/utils.ts'
import { PortalScope } from './PortalScope.tsx'

export const TooltipProvider = TooltipPrimitive.Provider

export const TooltipContent: FunctionComponent<
  TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset'>
> = ({ className, side = 'top', sideOffset = 6, ...props }) => (
  <TooltipPrimitive.Portal>
    <PortalScope>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className='isolate z-90'>
        <TooltipPrimitive.Popup
          data-slot='tooltip-content'
          className={cn(
            'rounded-md border border-border bg-surface px-2 py-1 text-label text-fg-2 shadow-(--shadow-md) outline-none',
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </PortalScope>
  </TooltipPrimitive.Portal>
)

/**
 * Convenience wrapper: `<Tip content="..."><Button/></Tip>`.
 *
 * Pass `render` when the trigger must *be* an element you already have — a tab, a
 * row — rather than something wrapped in a span. The default span is fine beside
 * a button but would break any layout that styles its own children (a flex tab
 * strip gets an extra box between the container and its items).
 */
export function Tip({
  content,
  render,
  side,
  children,
}: {
  content: ReactNode
  render?: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  children?: ReactNode
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={render ?? <span className='inline-flex' />}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipPrimitive.Root>
  )
}
