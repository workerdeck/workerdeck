import { type FunctionComponent } from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { PortalScope } from './PortalScope.tsx'

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value
export const SelectItemText = SelectPrimitive.ItemText

export const SelectTrigger: FunctionComponent<SelectPrimitive.Trigger.Props> = ({
  className,
  children,
  ...props
}) => (
  <SelectPrimitive.Trigger
    data-slot='select-trigger'
    className={cn(
      'inline-flex h-7 items-center justify-between gap-1.5 rounded-md border border-border bg-bg px-2 text-body-sm text-text',
      'transition-colors outline-none hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
      'data-popup-open:border-border-strong disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}>
    {children}
    <SelectPrimitive.Icon className='text-fg-4'>
      <ChevronsUpDown className='size-3.5' />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
)

export const SelectContent: FunctionComponent<
  SelectPrimitive.Popup.Props &
    Pick<SelectPrimitive.Positioner.Props, 'align' | 'alignItemWithTrigger' | 'side' | 'sideOffset'>
> = ({
  className,
  align = 'start',
  alignItemWithTrigger = false,
  side = 'bottom',
  sideOffset = 6,
  ...props
}) => (
  <SelectPrimitive.Portal>
    <PortalScope>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        side={side}
        sideOffset={sideOffset}
        className='isolate z-80 outline-none'>
        <SelectPrimitive.Popup
          data-slot='select-content'
          className={cn(
            'max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto',
            'rounded-md border border-border bg-surface p-1 text-fg-1 shadow-(--shadow-lg) outline-none',
            className,
          )}
          {...props}
        />
      </SelectPrimitive.Positioner>
    </PortalScope>
  </SelectPrimitive.Portal>
)

export const SelectItem: FunctionComponent<SelectPrimitive.Item.Props> = ({
  className,
  children,
  ...props
}) => (
  <SelectPrimitive.Item
    data-slot='select-item'
    className={cn(
      'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-body-sm text-text outline-none select-none',
      'data-highlighted:bg-surface-hover',
      className,
    )}
    {...props}>
    <span className='flex min-w-0 flex-1 flex-col gap-0.5'>{children}</span>
    <SelectPrimitive.ItemIndicator className='mt-0.5 text-fg-1'>
      <Check className='size-3.5' />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
)
