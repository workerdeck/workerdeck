import { type FunctionComponent } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

/**
 * A dismissible panel, sized for reading rather than confirming — the web
 * counterpart of the iOS app's detail sheets (context, usage, session info, MCP).
 *
 * Taller than {@link AlertDialogContent} and scrollable inside, because these
 * carry lists whose length is the engine's business, not the layout's.
 */
export const DialogContent: FunctionComponent<
  DialogPrimitive.Popup.Props & { size?: 'sm' | 'md' | 'lg' }
> = ({ className, children, size = 'md', ...props }) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-70 bg-black/40 backdrop-blur-[1px]',
        'transition-opacity duration-(--motion-base)',
        'data-starting-style:opacity-0 data-ending-style:opacity-0',
      )}
    />
    <DialogPrimitive.Popup
      data-slot='dialog-content'
      className={cn(
        'fixed top-1/2 left-1/2 z-70 flex max-h-[min(42rem,calc(100dvh-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col',
        size === 'sm' && 'w-[min(24rem,calc(100vw-2rem))]',
        size === 'md' && 'w-[min(32rem,calc(100vw-2rem))]',
        size === 'lg' && 'w-[min(46rem,calc(100vw-2rem))]',
        'rounded-lg border border-border bg-surface shadow-(--shadow-lg) outline-none',
        'transition-[opacity,transform] duration-(--motion-base)',
        'data-starting-style:scale-95 data-starting-style:opacity-0',
        'data-ending-style:scale-95 data-ending-style:opacity-0',
        className,
      )}
      {...props}>
      {children}
    </DialogPrimitive.Popup>
  </DialogPrimitive.Portal>
)

/** Title row with the close button, pinned above the scrolling body. */
export const DialogHeader: FunctionComponent<{
  title: string
  description?: string
  /** Rendered between the title and the close button. */
  actions?: React.ReactNode
}> = ({ title, description, actions }) => (
  <div className='flex items-start gap-2 border-b border-border px-4 py-3'>
    <div className='min-w-0 flex-1'>
      <DialogPrimitive.Title className='truncate text-body-sm font-semibold text-text'>
        {title}
      </DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description className='mt-0.5 text-label text-fg-4'>
          {description}
        </DialogPrimitive.Description>
      ) : null}
    </div>
    {actions}
    <DialogPrimitive.Close
      aria-label='Close'
      className='-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors outline-none hover:bg-surface-hover hover:text-fg-1'>
      <X className='size-3.5' />
    </DialogPrimitive.Close>
  </div>
)

/** The scrolling region under the header. */
export const DialogBody: FunctionComponent<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)} {...props} />

/** A label/value row — the shape every one of these panels is mostly made of. */
export const DialogRow: FunctionComponent<{
  label: string
  children: React.ReactNode
  mono?: boolean
}> = ({ label, children, mono }) => (
  <div className='flex items-baseline justify-between gap-4 py-1.5'>
    <span className='shrink-0 text-label text-fg-3'>{label}</span>
    <span className={cn('min-w-0 truncate text-right text-body-sm text-fg-1', mono && 'font-mono text-label')}>
      {children}
    </span>
  </div>
)
