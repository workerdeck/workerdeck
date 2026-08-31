import {
  imagePartRef,
  replayCoalesceKey,
  replayRetains,
  TOOL_RESULT_HEAD_CHARS,
  transcriptContent,
  type SessionEvent,
  type ToolResultBlock,
} from '@workerdeck/protocol'

export function staleReplaySeqs(events: readonly SessionEvent[], afterSeq: number): Set<number> {
  const stale = new Set<number>()
  const seen = new Set<string>()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.seq <= afterSeq) {
      break
    }
    const key = replayCoalesceKey(event)
    if (key === undefined) {
      continue
    }
    if (seen.has(key)) {
      stale.add(event.seq)
    } else {
      seen.add(key)
    }
  }
  return stale
}

export function replaySlice(
  events: readonly SessionEvent[],
  options: {
    afterSeq: number
    resetSeq?: number
    coalesceReplay?: boolean
    truncateResults?: boolean
    imageRefs?: boolean
  },
): SessionEvent[] {
  const { afterSeq, resetSeq = 0, coalesceReplay, truncateResults, imageRefs } = options
  const stale = coalesceReplay ? staleReplaySeqs(events, afterSeq) : undefined
  const lastSeq = events[events.length - 1]?.seq ?? 0
  const out: SessionEvent[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) {
      continue
    }
    if (event.seq < resetSeq && transcriptContent(event)) {
      continue
    }
    if (stale?.has(event.seq)) {
      continue
    }
    if (coalesceReplay && event.seq !== lastSeq && !replayRetains(event)) {
      continue
    }
    // Refs before heads: part indices are stamped from the stored array, which truncation reshapes.
    let delivered = event
    if (imageRefs) {
      delivered = refImageParts(delivered)
    }
    if (truncateResults) {
      delivered = truncateResultBlocks(delivered)
    }
    out.push(delivered)
  }
  return out
}

export function truncateResultBlocks(event: SessionEvent): SessionEvent {
  if (event.type !== 'user_message') {
    return event
  }
  const content = event.message.content
  if (!Array.isArray(content)) {
    return event
  }
  let cut = false
  const blocks = content.map((block) => {
    if (block.type !== 'tool_result') {
      return block
    }
    const result = block as ToolResultBlock
    if (result.truncated) {
      return block
    }
    const total = resultChars(result.content)
    if (total <= TOOL_RESULT_HEAD_CHARS) {
      return block
    }
    cut = true
    return {
      ...result,
      content: headOf(result.content, TOOL_RESULT_HEAD_CHARS),
      truncated: true,
      total_chars: total,
    } satisfies ToolResultBlock
  })
  if (!cut) {
    return event
  }
  return { ...event, message: { ...event.message, content: blocks } }
}

function resultChars(content: ToolResultBlock['content']): number {
  if (typeof content === 'string') {
    return content.length
  }
  if (!Array.isArray(content)) {
    return 0
  }
  return content.reduce((total, part, index) => total + (typeof part.text === 'string' ? part.text.length + (index > 0 ? 1 : 0) : 0), 0)
}

function headOf(content: ToolResultBlock['content'], chars: number): ToolResultBlock['content'] {
  if (typeof content === 'string') {
    return content.slice(0, chars)
  }
  if (!Array.isArray(content)) {
    return content
  }
  const parts: Array<{ type: string; text?: string; [key: string]: unknown }> = []
  let used = 0
  for (const part of content) {
    if (part.type === 'image_ref') {
      parts.push(part)
      continue
    }
    if (typeof part.text !== 'string') {
      continue
    }
    // `continue`, not `break`: an exhausted text budget must not strand the refs after it.
    if (used >= chars) {
      continue
    }
    const text = part.text.slice(0, chars - used)
    parts.push({ ...part, text })
    used += text.length + 1
  }
  return parts
}

export function refImageParts(event: SessionEvent): SessionEvent {
  if (event.type !== 'user_message') {
    return event
  }
  const content = event.message.content
  if (!Array.isArray(content)) {
    return event
  }
  let changed = false
  const blocks = content.map((block) => {
    if (block.type !== 'tool_result') {
      return block
    }
    const result = block as ToolResultBlock
    const parts = result.content
    if (!Array.isArray(parts)) {
      return block
    }
    let blockChanged = false
    const mapped = parts.map((part, index) => {
      const ref = imagePartRef(part, index)
      if (!ref) {
        return part
      }
      blockChanged = true
      return ref
    })
    if (!blockChanged) {
      return block
    }
    changed = true
    return { ...result, content: mapped } satisfies ToolResultBlock
  })
  if (!changed) {
    return event
  }
  return { ...event, message: { ...event.message, content: blocks } }
}
