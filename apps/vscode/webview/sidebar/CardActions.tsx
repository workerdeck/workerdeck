import { cn } from '@workerdeck/ui'
import { AppWindow, MoreHorizontal } from 'lucide-react'

export function CardActions({ inEditor, onMenu }: { inEditor: boolean; onMenu: () => void }) {
  return (
    <>
      {inEditor ? <AppWindow className="size-3.5 shrink-0 text-fg-4" aria-label="Open in an editor tab" /> : null}
      <button
        type="button"
        aria-label="Session actions"
        title="Session actions"
        onClick={(e) => {
          // The whole card is a button; this one does not mean "select".
          e.stopPropagation()
          onMenu()
        }}
        className={cn('flex shrink-0 items-center rounded-[4px] p-0.5 outline-none', 'text-fg-4 hover:bg-row-hover hover:text-fg-1')}
      >
        <MoreHorizontal className="size-4" />
      </button>
    </>
  )
}
