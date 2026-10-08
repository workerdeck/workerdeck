import type { ContentBlock, SessionEventBody } from '@workerdeck/protocol'

// The SDK sends one block per event, so "the block before" is remembered per API message id.
export class AddressedThinking {
  #last = new Map<string, { messageId: string; type: string }>()

  stamp(messageId: string | undefined, body: SessionEventBody): SessionEventBody {
    if (body.type !== 'assistant_message' || typeof body.message.content === 'string') {
      return body
    }
    const key = body.parentToolUseId ?? ''
    if (!messageId) {
      this.#last.delete(key)
      return body
    }
    let previous = this.#last.get(key)
    let stamped = false
    const content = body.message.content.map((block): ContentBlock => {
      const follows = previous?.messageId === messageId && previous.type === 'thinking'
      previous = { messageId, type: block.type }
      if (block.type === 'thinking' && follows && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
        stamped = true
        return { ...block, type: 'thinking', thinking: block.thinking, addressed: true }
      }
      return block
    })
    if (previous) {
      this.#last.set(key, previous)
    }
    return stamped ? { ...body, message: { ...body.message, content } } : body
  }

  reset(): void {
    this.#last.clear()
  }
}

export function apiMessageId(message: unknown): string | undefined {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : undefined
}
