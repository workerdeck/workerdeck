import { peerDeliveredPrefix } from '@workerdeck/protocol'
import type {
  ChecklistItem,
  ContentBlock,
  FilePatch,
  MessageOrigin,
  PermissionRequest,
  RateLimitInfo,
  SessionEventBody,
  SessionInfo,
  SessionStatus,
  ToolResultBlock,
} from '@workerdeck/protocol'

export type Cue = { gap: number } & ({ event: SessionEventBody } | { patch: Partial<SessionInfo> })

export type Beat = Cue[]

export type Part = Cue | Beat | number

export type SayOptions = { stream?: boolean; parent?: string | null; tools?: ContentBlock[] }

type TurnOptions = { durationMs?: number; numTurns?: number; totalCostUsd?: number }

const STREAM_GAP_MS = 120
const FIRST_TOKEN_MS = 1600
const TOOL_LATENCY_MS = 900
const TURN_SETTLE_MS = 600
const STREAM_WORDS = 1

let uid = 0

export function beat(...parts: Part[]): Beat {
  const out: Beat = []
  let carry = 0
  const push = (cue: Cue): void => {
    out.push({ ...cue, gap: cue.gap + carry })
    carry = 0
  }
  for (const part of parts) {
    if (typeof part === 'number') {
      carry += part
    } else if (Array.isArray(part)) {
      part.forEach(push)
    } else {
      push(part)
    }
  }
  return out
}

export function event(body: SessionEventBody): Cue {
  return { gap: 0, event: body }
}

export function patch(value: Partial<SessionInfo>): Cue {
  return { gap: 0, patch: value }
}

export function status(value: SessionStatus): Cue {
  return event({ type: 'status_changed', status: value })
}

export function user(text: string): Cue {
  return event({ type: 'user_message', message: { role: 'user', content: text }, parentToolUseId: null, uuid: nextId('u') })
}

export function say(text: string, options: SayOptions = {}): Beat {
  const parent = options.parent ?? null
  const uuid = nextId('a')
  const cues: Beat = []
  if (options.stream) {
    const words = text.split(' ')
    for (let index = 0; index < words.length; index += STREAM_WORDS) {
      const chunk = words.slice(index, index + STREAM_WORDS).join(' ')
      cues.push({
        gap: index === 0 ? FIRST_TOKEN_MS : STREAM_GAP_MS,
        event: {
          type: 'stream_delta',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: index === 0 ? chunk : ` ${chunk}` } },
          parentToolUseId: parent,
          uuid: `${uuid}:d${index}`,
        },
      })
    }
  }
  cues.push({
    gap: options.stream ? STREAM_GAP_MS : 0,
    event: {
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text }, ...(options.tools ?? [])] },
      parentToolUseId: parent,
      uuid,
    },
  })
  return cues
}

export function think(text: string, parent: string | null = null): Cue {
  return event({
    type: 'assistant_message',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text } as ContentBlock] },
    parentToolUseId: parent,
    uuid: nextId('t'),
  })
}

export function toolUse(id: string, name: string, input: Record<string, unknown>): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

export function tool(id: string, name: string, input: Record<string, unknown>, parent: string | null = null): Cue {
  return latent(TOOL_LATENCY_MS, {
    type: 'assistant_message',
    message: { role: 'assistant', content: [toolUse(id, name, input)] },
    parentToolUseId: parent,
    uuid: nextId('a'),
  })
}

export function result(id: string, output: string, extra: { patch?: FilePatch; isError?: boolean; parent?: string | null } = {}): Cue {
  const block: ToolResultBlock = { type: 'tool_result', tool_use_id: id, content: output, ...(extra.isError ? { is_error: true } : {}) }
  return event({
    type: 'user_message',
    message: { role: 'user', content: [block] },
    parentToolUseId: extra.parent ?? null,
    synthetic: true,
    uuid: `${id}:result`,
    ...(extra.patch ? { patch: extra.patch } : {}),
  })
}

export function checklist(items: ChecklistItem[]): Cue {
  return event({ type: 'checklist', items })
}

export function todos(...items: [ChecklistItem['status'], string][]): Cue {
  return checklist(items.map(([state, text]) => ({ text, status: state })))
}

export function ask(request: PermissionRequest): Cue {
  return event({ type: 'permission_requested', request })
}

export function resolved(requestId: string, behavior: 'allow' | 'deny' = 'allow'): Cue {
  return event({ type: 'permission_resolved', requestId, behavior, resolvedBy: 'client' })
}

export function turnEnd(options: TurnOptions = {}): Beat {
  return [
    latent(TURN_SETTLE_MS, {
      type: 'turn_result',
      subtype: 'success',
      isError: false,
      durationMs: options.durationMs ?? 42_000,
      numTurns: options.numTurns ?? 1,
      totalCostUsd: options.totalCostUsd ?? 0.12,
    }),
    status('idle'),
  ]
}

export function context(percentage: number, maxTokens = 200_000): Cue {
  const totalTokens = Math.round((maxTokens * percentage) / 100)
  return event({ type: 'context_usage', usage: { categories: [], totalTokens, maxTokens, percentage } })
}

export function rateLimit(info: RateLimitInfo): Cue {
  return event({ type: 'rate_limit', info })
}

export function peerSend(id: string, to: { sessionId: string; name: string }, text: string, delay = 900): Beat {
  return beat(
    tool(id, 'mcp__workerdeck__peers_send', { sessionId: to.sessionId, text }),
    delay,
    result(
      id,
      `${peerDeliveredPrefix(to.sessionId, to.name)}; it was idle and has started a turn on your message. Do not wait for a reply: it arrives as a message if the peer chooses to answer.`,
    ),
  )
}

export function peerMessage(from: Omit<MessageOrigin, 'kind'>, text: string): Cue {
  return event({
    type: 'user_message',
    message: { role: 'user', content: text },
    parentToolUseId: null,
    origin: { kind: 'peer', ...from },
    uuid: nextId('p'),
  })
}

export function wait(ms: number): number {
  return ms
}

function latent(gap: number, body: SessionEventBody): Cue {
  return { gap, event: body }
}

function nextId(prefix: string): string {
  uid += 1
  return `${prefix}-${uid}`
}
