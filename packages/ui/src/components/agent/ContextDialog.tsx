import type { ContextUsage } from '@workerdeck/protocol'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { cn } from '../../lib/utils.ts'
import { formatTokens } from '../../lib/format.ts'

export interface ContextDialogProps {
  usage?: ContextUsage
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

const cssColor = (color: string): string | undefined => (typeof CSS !== 'undefined' && CSS.supports('color', color) ? color : undefined)

const usageTint = (pct: number) => (pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-accent')

export function ContextDialog({ usage, open, onOpenChange, className }: ContextDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader title="Context" description={usage?.model} />
        <DialogBody>
          {!usage ? (
            <p className="py-6 text-center text-body-sm text-fg-4">
              No reading yet — the context window is measured after a turn completes.
            </p>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-label text-fg-3">Used</span>
                <span className="font-mono text-body-sm text-fg-1">
                  {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)} · {usage.percentage.toFixed(0)}%
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-border">
                <div
                  className={cn('h-full rounded-full', usageTint(usage.percentage))}
                  style={{ width: `${Math.min(100, Math.max(2, usage.percentage))}%` }}
                />
              </div>
              {usage.categories.length > 0 ? (
                <div className="mt-5">
                  <h3 className="text-label font-medium text-fg-3">Breakdown</h3>
                  <div className="mt-2 flex flex-col gap-3">
                    {usage.categories.map((category) => {
                      const share = (category.tokens / Math.max(usage.maxTokens, 1)) * 100
                      const color = cssColor(category.color)
                      return (
                        <div key={category.name}>
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className="size-2 shrink-0 rounded-full bg-fg-4"
                                style={color ? { backgroundColor: color } : undefined}
                              />
                              <span className="truncate text-body-sm text-fg-1">{category.name}</span>
                            </span>
                            <span className="shrink-0 font-mono text-label text-fg-3">{formatTokens(category.tokens)}</span>
                          </div>
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                            <div
                              className="h-full rounded-full bg-fg-4"
                              style={{
                                width: `${Math.min(100, share)}%`,
                                backgroundColor: color,
                              }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
