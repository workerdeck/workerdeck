import { type FunctionComponent } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { cn } from '../../lib/utils.ts'
import { PortalScope } from './PortalScope.tsx'

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger

export const MenuContent: FunctionComponent<
  MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>
> = ({ className, align = 'end', side = 'bottom', sideOffset = 6, ...props }) => (
  <MenuPrimitive.Portal>
    <PortalScope>
      <MenuPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="isolate z-80 outline-none">
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            'min-w-48 rounded-md border border-border bg-surface p-1 text-fg-1 shadow-(--shadow-lg) outline-none',
            'transition-[opacity,transform] duration-(--motion-base)',
            'data-starting-style:scale-95 data-starting-style:opacity-0',
            'data-ending-style:scale-95 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </PortalScope>
  </MenuPrimitive.Portal>
)

export const MenuItem: FunctionComponent<MenuPrimitive.Item.Props & { destructive?: boolean }> = ({ className, destructive, ...props }) => (
  <MenuPrimitive.Item
    data-slot="menu-item"
    className={cn(
      'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-body-sm outline-none select-none',
      'data-highlighted:bg-surface-hover',
      destructive ? 'text-danger' : 'text-text',
      className,
    )}
    {...props}
  />
)

export const MenuSeparator: FunctionComponent<MenuPrimitive.Separator.Props> = ({ className, ...props }) => (
  <MenuPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />
)
