import type { ArchivedView } from '@workerdeck/protocol'
import { History } from 'lucide-react'
import { archivedBannerText } from '../../lib/conversations.ts'
import { Button } from '../ui/Button.tsx'

export type ArchivedBannerProps = {
  view: ArchivedView
  onGoToCurrent?: (conversation: number) => void
  locale?: string
}

export function ArchivedBanner({ view, onGoToCurrent, locale }: ArchivedBannerProps) {
  const { headline, note } = archivedBannerText(view, locale)
  const current = view.current
  return (
    <div className="px-3 pt-2" data-slot="archived-banner">
      <div
        role="status"
        className="mx-auto flex w-full max-w-[var(--wd-transcript-max-width)] items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm text-fg-2"
      >
        <History className="size-3.5 shrink-0 text-fg-3" />
        <span className="min-w-0 flex-1 truncate">
          {headline}
          {note ? <span className="text-fg-4"> · {note}</span> : null}
        </span>
        {current !== undefined && onGoToCurrent ? (
          <Button variant="outline" size="xs" className="shrink-0" onClick={() => onGoToCurrent(current)}>
            Go to current
          </Button>
        ) : null}
      </div>
    </div>
  )
}
