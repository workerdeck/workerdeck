import { type ReactElement, type ReactNode } from 'react'
import { PreviewCard } from '@base-ui/react/preview-card'
import { cn } from '../../lib/utils.ts'
import { PortalScope } from './PortalScope.tsx'

export function HoverCard({
  trigger,
  children,
  side = 'bottom',
  delay = 400,
  className,
}: {
  trigger: ReactElement
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
  className?: string
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={trigger} delay={delay} closeDelay={100} />
      <PreviewCard.Portal>
        <PortalScope>
          <PreviewCard.Positioner side={side} sideOffset={6} collisionPadding={8} className="isolate z-90">
            <PreviewCard.Popup
              data-slot="hover-card"
              className={cn(
                'rounded-lg border border-border bg-surface p-3 text-fg-1 shadow-(--shadow-lg) outline-none',
                'transition-[opacity,transform] duration-(--motion-base)',
                'data-starting-style:scale-95 data-starting-style:opacity-0',
                'data-ending-style:scale-95 data-ending-style:opacity-0',
                className,
              )}
            >
              {children}
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PortalScope>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}
