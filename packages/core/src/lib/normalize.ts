import type { McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ApiMessage, ContentBlock, McpServerStatusInfo, ModelOption, SessionEventBody, TextBlock } from '@workerdeck/protocol'
import { filePatchFromToolResult } from './patch.ts'

/** Does this message answer exactly one tool call? A patch is per-file-edit and
 * the message says nothing about which of two results it describes, so anything
 * else gets no patch rather than a diff pinned to the wrong call. */
function singleToolResult(message: ApiMessage): boolean {
  const content = message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.filter((block) => block.type === 'tool_result').length === 1
}

/**
 * The wrappers the CLI writes into the transcript when the *harness* is talking
 * to the model rather than a person talking to the session.
 *
 * Deliberately a text test, and only these two. The live path has structure to
 * go on (`isSynthetic`, `origin.kind`), but **the resumed path has none**: the
 * SDK's `SessionMessage` carries exactly `message`, `uuid`, `session_id`,
 * `parent_tool_use_id`, `parent_agent_id` and `timestamp` — every one of
 * `isMeta`, `isSidechain`, `promptSource` and `origin` is dropped between the
 * stored JSONL and what `getSessionMessages` hands back (verified against real
 * transcripts). So on resume this is the only signal there is, and without it a
 * `<task-notification>` blob comes back as a blue user row and a scrubber mark,
 * as if someone had typed it.
 *
 * `<local-command-caveat>` is here for symmetry and cheap insurance: the SDK
 * filters `isMeta` entries out of a resumed transcript itself today, which is
 * not a contract anyone wrote down.
 *
 * What is *not* here matters as much:
 * - `<local-command-stdout>` — the reducer turns it into a notice row on
 *   purpose; marking it synthetic would delete a row both paths show.
 * - `<command-name>` — that is a person running a slash command. The reducer
 *   renders it as the command line they typed; hiding it would erase the turn's
 *   cause.
 */
const SYNTHETIC_USER_PREFIXES = ['<task-notification>', '<local-command-caveat>']

/** First text block's leading tag, for the test above. Tool results and images
 * carry no text and are never synthetic by this rule (a tool result is already
 * a tool result to every renderer). */
export function isSyntheticUserText(message: ApiMessage): boolean {
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
  /** 'pro' | 'max' | 'team' | 'enterprise', or null for API-key / 3P sessions. */
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
  // Server-driven per-model buckets, keyed off their display name so a client that
  // groups on the `seven_day_` prefix keeps them with the other weekly windows.
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

/**
 * The CLI's MCP status, as `McpServerStatusInfo`.
 *
 * The narrowing is the point: the SDK's config object carries `env` for stdio
 * servers and `headers` for HTTP ones, and both routinely hold API tokens. This
 * is the one place they are dropped, so no client — dashboard, phone, or a host
 * app reading the REST route — can turn "show me my MCP servers" into a
 * credential dump. Only the connection's identity survives.
 */
export function mcpStatusInfo(status: McpServerStatus): McpServerStatusInfo {
  const config = status.config as { type?: string; command?: string; args?: string[]; url?: string } | undefined
  // stdio is the CLI's implicit default: a config with a command and no type.
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

/** The half of the SDK's `ModelInfo` this package forwards. Structurally typed so
 * the mapping can be unit-tested without a live query. */
export type SdkModelInfo = {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  /** Per-model reasoning efforts, when the SDK reports them (0.3.221+). */
  supportedEffortLevels?: string[]
  supportsEffort?: boolean
}

/**
 * The CLI's model list, as `ModelOption[]`.
 *
 * Two decisions live here rather than in each client:
 *
 * - **`default` is dropped.** The CLI offers a row whose id is literally
 *   `default` ("Default (recommended)"), meaning "whatever I would have picked".
 *   It is a legal id to send, but it is not a model: a session running on it
 *   reports a real model, so a picker showing it has a row that can never be
 *   checked, and a status bar naming it would say "Default" for a session
 *   answering as Opus. Which model the default resolved to is a different
 *   question, and `system_init` answers it.
 * - **`primary` is derived.** The CLI reports one flat list; Claude Code's own
 *   picker shows the newest of each family and files the rest under "more
 *   models". The list arrives newest-first, so the first row of each family is
 *   the primary one. A heuristic, but a stable one — and doing it once here
 *   means the dashboard and the phone group identically.
 */
/** What the CLI's `default` row resolves to — the model a session will answer as
 * before it has answered anything. Dropped from the list, kept as this. */
export function defaultModelFromSdk(models: readonly SdkModelInfo[]): string | undefined {
  return models.find((model) => model.value === 'default')?.resolvedModel
}

export function modelOptionsFromSdk(models: readonly SdkModelInfo[]): ModelOption[] {
  const rows = models.filter((model) => model.value !== 'default')
  // A derived name is only used when it is unambiguous. Two rows of one model
  // (a 1M-context variant beside a plain one) would derive the same string, and
  // there the CLI's own names are the ones that tell them apart.
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
      // Carried through so a client can match the model a session *reports*
      // ('claude-opus-5[1m]') against the row that names it ('opus[1m]').
      resolvedModel: model.resolvedModel,
      displayName: derived && derivedCounts.get(derived) === 1 ? derived : model.displayName,
      description: model.description,
      primary,
      // Explicit [] when the CLI reports no effort support, so clients don't
      // fall back to the engine-wide default set for an effortless model.
      reasoningEfforts: model.supportedEffortLevels ?? (model.supportsEffort === false ? [] : undefined),
    }
  })

  // Capability order, which is what a person picking a model is choosing along
  // and what the CLI's own selector shows. The CLI reports its list in a
  // different order and gives no ranking field, so it is declared here — a
  // family this list has never heard of sorts after the known ones rather than
  // to the top, and ties keep the CLI's order.
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const rankA = familyRank(a.option)
      const rankB = familyRank(b.option)
      return rankA === rankB ? a.index - b.index : rankA - rankB
    })
    .map(({ option }) => option)
}

const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku']

function familyRank(option: ModelOption): number {
  const rank = FAMILY_ORDER.indexOf(modelFamily(option.resolvedModel ?? option.value))
  return rank === -1 ? FAMILY_ORDER.length : rank
}

/**
 * The name a person says, from a wire model id: 'claude-opus-5[1m]' → "Opus 5",
 * 'claude-haiku-4-5-20251001' → "Haiku 4.5".
 *
 * The CLI's own `displayName` is the family alone ("Opus", "Haiku") or carries a
 * variant instead of a version ("Opus (1M context)"), and the version is the part
 * that answers "is this the current one". It is only ever in the id, so it is
 * read from there. Returns null when the id has no version to read — a bare
 * alias like 'sonnet' — and the CLI's name stands.
 */
export function friendlyModelName(id: string): string | null {
  const withoutVariant = id.split('[')[0] ?? id
  const parts = withoutVariant.toLowerCase().split('-').filter(Boolean)
  if (parts[0] === 'claude') {
    parts.shift()
  }
  const family = parts.shift()
  if (!family) {
    return null
  }
  // Trailing snapshot date ('20251001') is a build, not a version.
  const version = parts.filter((part) => !/^\d{8}$/.test(part))
  if (version.length === 0 || version.some((part) => !/^\d+$/.test(part))) {
    return null
  }
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`
}

/** 'claude-opus-4-8[1m]' → "opus". The vendor prefix, the context-window suffix
 * and the version tail are all dropped; what is left is the family a person
 * names. Unrecognisable ids become their own family, so a model this rule has
 * never seen lands in the main list rather than being hidden. */
function modelFamily(id: string): string {
  const withoutVariant = id.split('[')[0] ?? id
  const parts = withoutVariant.toLowerCase().split('-')
  if (parts[0] === 'claude') {
    parts.shift()
  }
  return parts[0] ?? withoutVariant
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
    case 'user': {
      const message = toApiMessage(msg.message)
      return {
        type: 'user_message',
        message,
        parentToolUseId: msg.parent_tool_use_id,
        replay: 'isReplay' in msg && msg.isReplay === true ? true : undefined,
        // Three ways to be the harness rather than a person: the SDK says so,
        // the message's origin says so (a background task reporting in is not
        // someone typing), or the text is one of the CLI's own wrappers — which
        // is the only one of the three a *resumed* transcript still carries.
        synthetic: msg.isSynthetic === true || msg.origin?.kind === 'task-notification' || isSyntheticUserText(message) ? true : undefined,
        // The engine's own line numbers, projected down to the hunks — see
        // `filePatchFromToolResult` for why the rest of `tool_use_result` stays
        // off the wire. Only with a single tool_result block, because nothing
        // in the message says which call a patch belongs to.
        patch: singleToolResult(message) ? filePatchFromToolResult(msg.tool_use_result) : undefined,
        uuid: msg.uuid,
      }
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
    case 'conversation_reset':
      // /clear, plan-mode exit, fresh-conversation flows: same session, fresh
      // conversation. The runner reacts to this body too (reset watermark,
      // sdkSessionId adoption) — see SessionRunner.#handleMessage.
      return { type: 'conversation_reset', sdkSessionId: msg.new_conversation_id }
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
      if (msg.subtype === 'init' || msg.subtype === 'session_state_changed') {
        return null
      }
      return { type: 'sdk_event', payload: msg as unknown as { type: string } }
    default:
      return { type: 'sdk_event', payload: msg as unknown as { type: string } }
  }
}
