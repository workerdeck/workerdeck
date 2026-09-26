import { type FunctionComponent } from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '../../lib/utils.ts'
import { PortalScope } from './PortalScope.tsx'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger

export const PopoverContent: FunctionComponent<
  PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>
> = ({ className, align = 'end', side = 'bottom', sideOffset = 6, ...props }) => (
  <PopoverPrimitive.Portal>
    <PortalScope>
      <PopoverPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="isolate z-80 outline-none">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'rounded-md border border-border bg-surface p-2 text-fg-1 shadow-(--shadow-lg) outline-none',
            'transition-[opacity,transform] duration-(--motion-base)',
            'data-starting-style:scale-95 data-starting-style:opacity-0',
            'data-ending-style:scale-95 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PortalScope>
  </PopoverPrimitive.Portal>
)
