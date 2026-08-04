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

/** The half of the CLI's `/usage` response this package reads. Structurally typed
 * rather than imported: the SDK marks the control request experimental and its
 * method name says so out loud, so the runner probes for it at runtime and this
 * describes only the fields it needs. */
export type UsageRateLimits = {
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: UsageWindow
    seven_day?: UsageWindow
    seven_day_opus?: UsageWindow
    seven_day_sonnet?: UsageWindow
    seven_day_oauth_apps?: UsageWindow
    model_scoped?: Array<{ display_name: string; utilization: number | null }>
  } | null
}

type UsageWindow = { utilization: number | null; resets_at?: string | null } | null | undefined

/**
 * Plan rate-limit windows from the CLI's structured `/usage` data, as `rate_limit`
 * events — the same shape a live `rate_limit_event` produces.
 *
 * Without this a client shows no usage at all until a window *changes*, which the
 * CLI only reports after a turn moves the needle, and never for a session that is
 * only being watched. Polling the snapshot and forwarding it through the existing
 * event means replay, the dashboard and the iOS app all get it for free, with no
 * new protocol surface.
 *
 * `status` is not per-window in the usage payload — 'allowed' is what a session
 * the CLI is running for us is, by construction. A window with no utilization is
 * unknown, not zero, and is dropped rather than reported at 0%.
 */
export function rateLimitEventsFromUsage(usage: UsageRateLimits): SessionEventBody[] {
  if (!usage.rate_limits_available || !usage.rate_limits) return []
  const limits = usage.rate_limits
  const events: SessionEventBody[] = []
  const seen = new Set<string>()
  const push = (rateLimitType: string, window: UsageWindow): void => {
    if (!window || window.utilization === null || seen.has(rateLimitType)) return
    seen.add(rateLimitType)
    const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN
    events.push({
      type: 'rate_limit',
      info: {
        status: 'allowed',
        rateLimitType,
        utilization: window.utilization,
        ...(Number.isFinite(resetsAt) ? { resetsAt: resetsAt / 1000 } : {}),
      },
    })
  }
  push('five_hour', limits.five_hour)
  push('seven_day', limits.seven_day)
  push('seven_day_opus', limits.seven_day_opus)
  push('seven_day_sonnet', limits.seven_day_sonnet)
  push('seven_day_oauth_apps', limits.seven_day_oauth_apps)
  // Server-driven per-model buckets, keyed off their display name so a client that
  // groups on the `seven_day_` prefix keeps them with the other weekly windows.
  for (const bucket of limits.model_scoped ?? []) {
    const slug = bucket.display_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    if (slug) push(`seven_day_${slug}`, bucket)
  }
  return events
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
