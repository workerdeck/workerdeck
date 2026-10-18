import { createRequire } from 'node:module'
import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEventBody } from '@workerdeck/protocol'
import { isSyntheticUserText, toApiMessage } from '../../lib/normalize.ts'
import { withoutPeerContextMessage } from '../../lib/peers.ts'
import { AddressedThinking, apiMessageId } from './addressed-thinking.ts'

export function claudeHistoryEvent(m: SessionMessage, addressed: AddressedThinking): SessionEventBody | undefined {
  if (m.type === 'user') {
    const raw = toApiMessage(m.message)
    const { message, origin } = m.parent_tool_use_id == null ? withoutPeerContextMessage(raw) : { message: raw }
    return {
      type: 'user_message',
      message,
      parentToolUseId: m.parent_tool_use_id,
      replay: true,
      synthetic: isSyntheticUserText(message) ? true : undefined,
      ...(origin ? { origin } : {}),
      uuid: m.uuid,
    }
  }
  if (m.type === 'assistant') {
    return addressed.stamp(apiMessageId(m.message), {
      type: 'assistant_message',
      message: toApiMessage(m.message),
      parentToolUseId: m.parent_tool_use_id,
      replay: true,
      uuid: m.uuid,
    })
  }
  return undefined
}

export function claudeHistoryEvents(messages: readonly SessionMessage[]): SessionEventBody[] {
  const addressed = new AddressedThinking()
  const events: SessionEventBody[] = []
  for (const m of messages) {
    const body = claudeHistoryEvent(m, addressed)
    if (body) {
      events.push(body)
    }
  }
  return events
}

export function resolveClaudeSdkEntry(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
  } catch {
    return undefined
  }
}

export function claudeSessionMessages(sessionId: string, options: { dir?: string }): Promise<SessionMessage[]> {
  return getSessionMessages(sessionId, options)
}
