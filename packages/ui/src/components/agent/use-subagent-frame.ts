import { useMemo } from 'react'
import { subagentLabel, type SessionInfo } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { subagentItems, type ToolCallItem } from '../terminal/blocks.ts'
import { useFrame } from './use-frame.ts'

export function useSubagentFrame(options: {
  sessionId: string | undefined
  items: TranscriptItem[]
  session: SessionInfo | undefined
  reveal?: { toolUseId: string; nonce: number }
  openSubagent?: { toolUseId: string; nonce: number }
  onSubagentChange?: (toolUseId: string | undefined) => void
}) {
  const { sessionId, items, session, reveal, openSubagent, onSubagentChange } = options

  const frame = useFrame({
    sessionId,
    request: openSubagent && { id: openSubagent.toolUseId, nonce: openSubagent.nonce },
    reveal,
    onChange: onSubagentChange,
    returnTo: (toolUseId) => toolUseId,
  })
  const subagentId = frame.id

  const frameItems = useMemo(() => (subagentId === undefined ? [] : subagentItems(items, subagentId)), [items, subagentId])
  const task = useMemo(
    () =>
      subagentId === undefined
        ? undefined
        : items.find((item): item is ToolCallItem => item.kind === 'tool_call' && item.id === subagentId),
    [items, subagentId],
  )
  const fallbackLabel = useMemo(() => {
    const record = session?.subagents?.find((sub) => sub.toolUseId === subagentId)
    return record ? subagentLabel(record) : 'Sub-agent'
  }, [session, subagentId])

  return {
    subagentId,
    enterSubagent: frame.enter,
    leaveSubagent: frame.leave,
    returnReveal: frame.returnReveal,
    frameItems,
    task,
    fallbackLabel,
  }
}
