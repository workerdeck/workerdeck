import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { subagentLabel, type SessionInfo } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { subagentItems, type ToolCallItem } from '../terminal/blocks.ts'

/**
 * The sub-agent frame machine: which agent frame is on screen, how it is entered (a host
 * `openSubagent` request or a Task row in the transcript), how it is left (Escape, the strip's
 * Back, or the host withdrawing), and what the transcript reveals on the way out. The frame
 * round-trips through the host's URL — the anti-loop rules live in GOTCHAS ("The sub-agent
 * frame round-trips through the URL"); here they mean: entry keys on the nonce alone, and the
 * report is deduped through a ref, so an echo of our own report is inert on arrival.
 */
export function useSubagentFrame(options: {
  sessionId: string | undefined
  items: TranscriptItem[]
  session: SessionInfo | undefined
  /** Host request to reveal a transcript row; entering a frame must not eat a pending one. */
  reveal?: { toolUseId: string; nonce: number }
  /** Host request to enter a frame; `toolUseId: undefined` withdraws it (Back/Forward). */
  openSubagent?: { toolUseId: string; nonce: number }
  onSubagentChange?: (toolUseId: string | undefined) => void
}) {
  const { sessionId, items, session, reveal, openSubagent, onSubagentChange } = options

  const [subagentId, setSubagentId] = useState<string | undefined>(undefined)
  const [returnReveal, setReturnReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  useEffect(() => {
    setSubagentId(undefined)
    setReturnReveal(undefined)
  }, [sessionId])

  // Leaving a frame reveals the Task row it came from, so the reader lands where they left.
  const leaveSubagent = useCallback(() => {
    setSubagentId((current) => {
      if (current !== undefined) {
        setReturnReveal({ toolUseId: current, nonce: Date.now() })
      }
      return undefined
    })
  }, [])

  const openSubagentNonce = openSubagent?.nonce
  const openSubagentId = openSubagent?.toolUseId
  useEffect(() => {
    if (openSubagentId === undefined) {
      leaveSubagent()
    } else {
      setSubagentId(openSubagentId)
    }
    // Keyed on the nonce alone: an unchanged nonce is the host echoing our own report, and
    // acting on it starts the URL → panel → URL cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSubagentNonce])

  // A reveal targets the root transcript, so it closes whatever frame is open — without the
  // return reveal, which would fight the requested one.
  const revealNonce = reveal?.nonce
  useEffect(() => {
    if (revealNonce === undefined) {
      return
    }
    setSubagentId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce])

  useEffect(() => {
    if (subagentId === undefined) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      leaveSubagent()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [subagentId, leaveSubagent])

  const onSubagentChangeRef = useRef(onSubagentChange)
  onSubagentChangeRef.current = onSubagentChange
  const reportedSubagentId = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (reportedSubagentId.current === subagentId) {
      return
    }
    reportedSubagentId.current = subagentId
    onSubagentChangeRef.current?.(subagentId)
  }, [subagentId])

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

  return { subagentId, enterSubagent: setSubagentId, leaveSubagent, returnReveal, frameItems, task, fallbackLabel }
}
