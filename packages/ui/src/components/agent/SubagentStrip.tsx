import type { TranscriptItem } from '@workerdeck/react'
import { formatDuration } from '../../lib/format.ts'
import { taskBusy, taskFailed, taskIdentity } from '../terminal/tool-run.ts'
import type { ToolCallItem } from '../terminal/blocks.ts'
import { usePulse } from './pulse.tsx'
import { useTicker } from '../terminal/items.tsx'
import { FrameStrip } from './FrameStrip.tsx'

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

  return (
    <FrameStrip
      kind="subagent"
      name={name}
      status={status}
      detail={detail}
      failed={failed}
      live={busy}
      onBack={onBack}
      terminal={terminal}
      fontSize={fontSize}
      lineHeight={lineHeight}
    />
  )
}
