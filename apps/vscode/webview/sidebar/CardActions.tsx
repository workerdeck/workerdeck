import { AppWindow } from 'lucide-react'

export function CardActions({ inEditor }: { inEditor: boolean }) {
  return inEditor ? <AppWindow className="size-3.5 shrink-0 text-fg-4" aria-label="Open in an editor tab" /> : null
}
