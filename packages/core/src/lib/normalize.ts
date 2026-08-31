import type { McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ApiMessage, ContentBlock, McpServerStatusInfo, ModelOption, SessionEventBody, TextBlock } from '@workerdeck/protocol'
import { filePatchFromToolResult } from './patch.ts'

const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku']

const singleToolResult = (message: ApiMessage): boolean => {
  const content = message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.filter((block) => block.type === 'tool_result').length === 1
}

const SYNTHETIC_USER_PREFIXES = ['<task-notification>', '<local-command-caveat>']

export const isSyntheticUserText = (message: ApiMessage): boolean => {
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find((block): block is TextBlock => block.type === 'text')?.text
        : undefined
  if (typeof text !== 'string') {
    return false
  }
  const head = text.trimStart()
  return SYNTHETIC_USER_PREFIXES.some((prefix) => head.startsWith(prefix))
}

export const toApiMessage = (message: unknown): ApiMessage => {
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

export type UsageRateLimits = {
  subscription_type?: string | null
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

export const rateLimitEventsFromUsage = (usage: UsageRateLimits): SessionEventBody[] => {
  if (!usage.rate_limits_available || !usage.rate_limits) {
    return []
  }
  const limits = usage.rate_limits
  const events: SessionEventBody[] = []
  const seen = new Set<string>()
  const push = (rateLimitType: string, window: UsageWindow): void => {
    if (!window || window.utilization === null || seen.has(rateLimitType)) {
      return
    }
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
  for (const bucket of limits.model_scoped ?? []) {
    const slug = bucket.display_name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
    if (slug) {
      push(`seven_day_${slug}`, bucket)
    }
  }
  return events
}

// `config` carries a stdio server's env and an HTTP server's headers, routinely API tokens:
// this is the one place they are dropped, and they must stay dropped.
export const mcpStatusInfo = (status: McpServerStatus): McpServerStatusInfo => {
  const config = status.config as { type?: string; command?: string; args?: string[]; url?: string } | undefined
  const transport = config?.type ?? (config?.command ? 'stdio' : undefined)
  return {
    name: status.name,
    status: status.status,
    scope: status.scope,
    error: status.error,
    serverInfo: status.serverInfo,
    transport: transport === 'stdio' || transport === 'http' || transport === 'sse' || transport === 'sdk' ? transport : undefined,
    command: config?.command,
    args: config?.args,
    url: config?.url,
    tools: status.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
    })),
  }
}

export type SdkModelInfo = {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportedEffortLevels?: string[]
  supportsEffort?: boolean
}

export const defaultModelFromSdk = (models: readonly SdkModelInfo[]): string | undefined => {
  return models.find((model) => model.value === 'default')?.resolvedModel
}

export const modelOptionsFromSdk = (models: readonly SdkModelInfo[]): ModelOption[] => {
  const rows = models.filter((model) => model.value !== 'default')
  const derivedCounts = new Map<string, number>()
  for (const model of rows) {
    const derived = friendlyModelName(model.resolvedModel ?? model.value)
    if (derived) {
      derivedCounts.set(derived, (derivedCounts.get(derived) ?? 0) + 1)
    }
  }

  const seenFamilies = new Set<string>()
  const options: ModelOption[] = rows.map((model) => {
    const family = modelFamily(model.resolvedModel ?? model.value)
    const primary = !seenFamilies.has(family)
    seenFamilies.add(family)
    const derived = friendlyModelName(model.resolvedModel ?? model.value)
    return {
      value: model.value,
      resolvedModel: model.resolvedModel,
      displayName: derived && derivedCounts.get(derived) === 1 ? derived : model.displayName,
      description: model.description,
      primary,
      reasoningEfforts: model.supportedEffortLevels ?? (model.supportsEffort === false ? [] : undefined),
    }
  })

  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const rankA = familyRank(a.option)
      const rankB = familyRank(b.option)
      return rankA === rankB ? a.index - b.index : rankA - rankB
    })
    .map(({ option }) => option)
}

const familyRank = (option: ModelOption): number => {
  const rank = FAMILY_ORDER.indexOf(modelFamily(option.resolvedModel ?? option.value))
  return rank === -1 ? FAMILY_ORDER.length : rank
}

export const friendlyModelName = (id: string): string | null => {
  const withoutVariant = id.split('[')[0] ?? id
  const parts = withoutVariant.toLowerCase().split('-').filter(Boolean)
  if (parts[0] === 'claude') {
    parts.shift()
  }
  const family = parts.shift()
  if (!family) {
    return null
  }
  const version = parts.filter((part) => !/^\d{8}$/.test(part))
  if (version.length === 0 || version.some((part) => !/^\d+$/.test(part))) {
    return null
  }
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`
}

const modelFamily = (id: string): string => {
  const withoutVariant = id.split('[')[0] ?? id
  const parts = withoutVariant.toLowerCase().split('-')
  if (parts[0] === 'claude') {
    parts.shift()
  }
  return parts[0] ?? withoutVariant
}

export const normalizeSdkMessage = (msg: SDKMessage): SessionEventBody | null => {
  switch (msg.type) {
    case 'assistant': {
      return {
        type: 'assistant_message',
        message: toApiMessage(msg.message),
        parentToolUseId: msg.parent_tool_use_id,
        uuid: msg.uuid,
      }
    }
    case 'user': {
      const message = toApiMessage(msg.message)
      return {
        type: 'user_message',
        message,
        parentToolUseId: msg.parent_tool_use_id,
        replay: 'isReplay' in msg && msg.isReplay === true ? true : undefined,
        synthetic: msg.isSynthetic === true || msg.origin?.kind === 'task-notification' || isSyntheticUserText(message) ? true : undefined,
        patch: singleToolResult(message) ? filePatchFromToolResult(msg.tool_use_result) : undefined,
        uuid: msg.uuid,
      }
    }
    case 'stream_event': {
      return {
        type: 'stream_delta',
        event: msg.event as { type: string; [key: string]: unknown },
        parentToolUseId: msg.parent_tool_use_id,
        uuid: msg.uuid,
      }
    }
    case 'result': {
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
    }
    case 'conversation_reset': {
      return { type: 'conversation_reset', sdkSessionId: msg.new_conversation_id }
    }
    case 'rate_limit_event': {
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
    }
    case 'system': {
      if (msg.subtype === 'init' || msg.subtype === 'session_state_changed') {
        return null
      }
      return { type: 'sdk_event', payload: msg as unknown as { type: string } }
    }
    default: {
      return { type: 'sdk_event', payload: msg as unknown as { type: string } }
    }
  }
}
