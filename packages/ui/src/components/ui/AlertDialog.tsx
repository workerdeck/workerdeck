import { type FunctionComponent } from 'react'
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import { cn } from '../../lib/utils.ts'
import { PortalScope } from './PortalScope.tsx'

export const AlertDialog = AlertDialogPrimitive.Root
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger
export const AlertDialogClose = AlertDialogPrimitive.Close

export const AlertDialogContent: FunctionComponent<AlertDialogPrimitive.Popup.Props> = ({
  className,
  children,
  ...props
}) => (
  <AlertDialogPrimitive.Portal>
    <PortalScope>
      <AlertDialogPrimitive.Backdrop
        className={cn(
          'fixed inset-0 z-70 bg-black/40 backdrop-blur-[1px]',
          'transition-opacity duration-(--motion-base)',
          'data-starting-style:opacity-0 data-ending-style:opacity-0',
        )}
      />
      <AlertDialogPrimitive.Popup
        data-slot='alert-dialog-content'
        className={cn(
          'fixed top-1/2 left-1/2 z-70 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
          'rounded-lg border border-border bg-surface p-5 shadow-(--shadow-lg) outline-none',
          'transition-[opacity,transform] duration-(--motion-base)',
          'data-starting-style:scale-95 data-starting-style:opacity-0',
          'data-ending-style:scale-95 data-ending-style:opacity-0',
          className,
        )}
        {...props}>
        {children}
      </AlertDialogPrimitive.Popup>
    </PortalScope>
  </AlertDialogPrimitive.Portal>
)

export const AlertDialogTitle: FunctionComponent<AlertDialogPrimitive.Title.Props> = ({
  className,
  ...props
}) => (
  <AlertDialogPrimitive.Title
    className={cn('text-heading-3 font-semibold text-text', className)}
    {...props}
  />
)

export const AlertDialogDescription: FunctionComponent<AlertDialogPrimitive.Description.Props> = ({
  className,
  ...props
}) => (
  <AlertDialogPrimitive.Description
    className={cn('mt-1.5 text-body-sm text-muted-foreground', className)}
    {...props}
  />
)
