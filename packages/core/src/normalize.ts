import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ApiMessage, ContentBlock, SessionEventBody } from '@workerdeck/protocol'

export function toApiMessage(message: unknown): ApiMessage {
  const m = message as {
    role?: 'user' | 'assistant'
    content: string | ContentBlock[]
    model?: string
    stop_reason?: string | null
    usage?: ApiMessage['usage']
  }
  return {
    role: m.role ?? 'assistant',
    content: m.content,
    model: m.model,
    stop_reason: m.stop_reason,
    usage: m.usage,
  }
}

/**
 * Map one SDKMessage to a wire-protocol event body, or null for messages the runner
 * consumes itself (system_init and session-state changes carry runner state and are
 * emitted by the runner with extra context).
 */
export function normalizeSdkMessage(msg: SDKMessage): SessionEventBody | null {
  switch (msg.type) {
    case 'assistant':
      return {
        type: 'assistant_message',
        message: toApiMessage(msg.message),
        parentToolUseId: msg.parent_tool_use_id,
        uuid: msg.uuid,
      }
    case 'user':
      return {
        type: 'user_message',
        message: toApiMessage(msg.message),
        parentToolUseId: msg.parent_tool_use_id,
        replay: 'isReplay' in msg && msg.isReplay === true ? true : undefined,
        synthetic: msg.isSynthetic === true ? true : undefined,
        uuid: msg.uuid,
      }
    case 'stream_event':
      return {
        type: 'stream_delta',
        event: msg.event as { type: string; [key: string]: unknown },
        parentToolUseId: msg.parent_tool_use_id,
        uuid: msg.uuid,
      }
    case 'result':
      return {
        type: 'turn_result',
        subtype: msg.subtype,
        isError: msg.is_error,
        durationMs: msg.duration_ms,
        numTurns: msg.num_turns,
        totalCostUsd: msg.total_cost_usd,
        result: msg.subtype === 'success' ? msg.result : undefined,
        errors: msg.subtype === 'success' ? undefined : msg.errors,
        usage: msg.usage,
      }
    case 'rate_limit_event':
      return {
        type: 'rate_limit',
        info: {
          status: msg.rate_limit_info.status,
          rateLimitType: msg.rate_limit_info.rateLimitType,
          utilization: msg.rate_limit_info.utilization,
          resetsAt: msg.rate_limit_info.resetsAt,
          isUsingOverage: msg.rate_limit_info.isUsingOverage,
        },
      }
    case 'system':
      // init and session_state_changed are handled by the runner directly.
      if (msg.subtype === 'init' || msg.subtype === 'session_state_changed') return null
      return { type: 'sdk_event', payload: msg as unknown as { type: string } }
    default:
      return { type: 'sdk_event', payload: msg as unknown as { type: string } }
  }
}
