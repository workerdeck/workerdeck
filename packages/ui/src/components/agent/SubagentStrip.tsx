import { ArrowLeft } from 'lucide-react'
import type { TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { formatDuration } from '../../lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { Ink, Row } from '../terminal/row.tsx'
import { TerminalSurface } from '../terminal/surface.tsx'
import { taskBusy, taskFailed, taskIdentity } from '../terminal/tool-run.ts'
import type { ToolCallItem } from '../terminal/blocks.ts'
import { usePulse } from './pulse.tsx'
import { useTicker } from '../terminal/items.tsx'

export function SubagentStrip({
  task,
  items,
  label,
  onBack,
  terminal,
  fontSize,
  lineHeight,
}: {
  task: ToolCallItem | undefined
  items: readonly TranscriptItem[]
  label: string
  onBack: () => void
  terminal: boolean
  fontSize?: number
  lineHeight?: number
}) {
  const busy = task ? taskBusy(task, items) : false
  const failed = task ? taskFailed(task) : false
  const pulse = usePulse(busy)
  const tools = items.reduce((n, item) => n + (item.kind === 'tool_call' ? 1 : 0), 0)
  const startedAt = busy ? task?.ts : undefined
  const now = useTicker(startedAt !== undefined)
  const elapsed = startedAt === undefined ? undefined : formatDuration(now - startedAt)

  const name = task ? taskIdentity(task) : label
  const status = !task ? undefined : failed ? 'failed' : busy ? `${pulse} working…` : 'done'
  const detail = [tools > 0 ? `${tools} tool${tools === 1 ? '' : 's'}` : undefined, elapsed].filter(Boolean).join(' · ')

  if (terminal) {
    return (
      <TerminalSurface fontSize={fontSize} lineHeight={lineHeight} className="shrink-0">
        <button type="button" onClick={onBack} aria-label="Back to the session" className="block w-full cursor-pointer text-left">
          <Row glyph="←" glyphTone="dim" indent={1} tone={failed ? 'red' : 'green'}>
            {name}
            {status ? <Ink tone={failed ? 'red' : busy ? 'mark' : 'dim'}> · {status}</Ink> : null}
            {detail ? <Ink tone="faint"> · {detail}</Ink> : null}
          </Row>
        </button>
      </TerminalSurface>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Button variant="ghost" size="sm" onClick={onBack} className="h-6 gap-1 px-1.5">
        <ArrowLeft className="size-3.5" />
        Back
      </Button>
      <span className={cn('min-w-0 flex-1 truncate text-body-sm', failed ? 'text-danger' : 'text-fg-2')}>{name}</span>
      {status ? (
        <span className={cn('shrink-0 text-label', failed ? 'text-danger' : busy ? 'text-accent' : 'text-fg-3')}>{status}</span>
      ) : null}
      {detail ? <span className="shrink-0 text-label text-fg-4">{detail}</span> : null}
    </div>
  )
}
