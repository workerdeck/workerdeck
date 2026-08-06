/**
 * Structural mirror of the slice of the `codex app-server` JSON-RPC v2 surface
 * this engine consumes. Local on purpose: no published client for this
 * protocol exists, the shapes are regenerated from the binary itself
 * (`codex app-server generate-json-schema --out <dir>`, verified 2026-08-05
 * against 0.146.0), and every open-ended axis is a plain string so a newer
 * binary degrades to the unknown-item path instead of a type error.
 *
 * Naming note: the v2 surface is camelCase (`aggregatedOutput`, `exitCode`,
 * `localImage`) where `codex exec`'s JSONL — the retired first transport, and
 * what OpenAI's own docs mostly show — is snake_case. The two vocabularies
 * look alike but are not interchangeable.
 */

/** `TokenUsageBreakdown` — one entry of `thread/tokenUsage/updated`. OpenAI
 * accounting: `inputTokens` INCLUDES the cached share (the relation the
 * runner's subtraction assumes, asserted in `smoke:codex`). */
export type AppServerTokenUsage = {
  inputTokens: number
  cachedInputTokens: number
  /** Default 0 in the schema; absent in some payloads. */
  cacheWriteInputTokens?: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

/** One subscription window as codex reports it. Note the shape difference from
 * the Claude side: windows are positional (`primary`/`secondary`) and carry
 * their length in minutes rather than being named — see the mapping in
 * `runner.ts` and `docs/GOTCHAS.md` §Codex. */
export type AppServerRateLimitWindow = {
  usedPercent?: number | null
  windowDurationMins?: number | null
  /** Epoch **seconds**, matching the protocol's `RateLimitInfo.resetsAt`. */
  resetsAt?: number | null
}

/** `account/rateLimits/updated` params (also `account/rateLimits/read`'s result
 * shape under `rateLimits`). Pushed during a turn, so no polling is needed. */
export type AppServerRateLimits = {
  primary?: AppServerRateLimitWindow | null
  secondary?: AppServerRateLimitWindow | null
  /** 'plus' | 'pro' | … — the ChatGPT plan, protocol's `plan_info`. */
  planType?: string | null
  /** Non-null when a limit is actually being enforced right now. */
  rateLimitReachedType?: string | null
}

/** `thread/tokenUsage/updated` params. `last` is the last model request, not
 * the turn — a tool-looping turn updates several times, so per-turn usage is
 * the sum of `last` values seen during the turn. */
export type AppServerTokenUsageUpdate = {
  threadId: string
  turnId: string
  tokenUsage: { last: AppServerTokenUsage; total: AppServerTokenUsage; modelContextWindow?: number | null }
}

export type AppServerAgentMessageItem = { id: string; type: 'agentMessage'; text: string }
/** `summary` is what streams by default (`item/reasoning/summaryTextDelta`);
 * `content` is raw CoT and only populated when the operator's config asks. */
export type AppServerReasoningItem = {
  id: string
  type: 'reasoning'
  content?: string[]
  summary?: string[]
}
export type AppServerCommandExecutionItem = {
  id: string
  type: 'commandExecution'
  command: string
  aggregatedOutput?: string
  exitCode?: number | null
  /** 'inProgress' | 'completed' | 'failed' | 'declined' — open. */
  status: string
}
/** v2 `kind` is an object (`{type: 'add'|'delete'|'update', move_path?}`) —
 * the snake_case JSONL's was a bare string; mapped defensively. */
export type AppServerFileChangeItem = {
  id: string
  type: 'fileChange'
  changes: Array<{ path: string; kind: string | { type: string }; diff?: string }>
  status: string
}
export type AppServerMcpToolCallItem = {
  id: string
  type: 'mcpToolCall'
  server: string
  tool: string
  arguments: unknown
  result?: unknown
  error?: { message: string } | null
  status: string
}
export type AppServerWebSearchItem = { id: string; type: 'webSearch'; query: string }
/**
 * A picture the model made with codex's built-in `image_gen` tool.
 *
 * `savedPath` is an absolute path on the **host** — by default under
 * `$CODEX_HOME/generated_images/`, or inside the workspace when the model was
 * told the asset belongs to the project. It is the only reference we get: the
 * app-server never sends the bytes, and neither do we (the event log carries
 * references, never base64 — see the protocol's note on attachments).
 *
 * `result` is an undocumented free-form string. Treated as untrusted length:
 * short values are shown, anything long enough to be an encoded image is not.
 */
export type AppServerImageGenerationItem = {
  id: string
  type: 'imageGeneration'
  status: string
  revisedPrompt?: string | null
  result: string
  savedPath?: string
}
/** The model *looked at* an image on disk (`path`, host-absolute). */
export type AppServerImageViewItem = { id: string; type: 'imageView'; path: string }
/** The user's own message, echoed back as an item — dropped (the runner
 * already emitted its `user_message`). */
export type AppServerUserMessageItem = { id: string; type: 'userMessage'; content?: unknown }
/** Forward-compatible fallback — not a union member (an index signature would
 * defeat discriminant narrowing); unknown items are cast to this. */
export type AppServerUnknownItem = { id: string; type: string; [key: string]: unknown }

export type AppServerItem =
  | AppServerAgentMessageItem
  | AppServerReasoningItem
  | AppServerCommandExecutionItem
  | AppServerFileChangeItem
  | AppServerMcpToolCallItem
  | AppServerWebSearchItem
  | AppServerImageGenerationItem
  | AppServerImageViewItem
  | AppServerUserMessageItem

/** The `Turn` object of `turn/started` / `turn/completed`. */
export type AppServerTurn = {
  id: string
  /** 'inProgress' | 'completed' | 'failed' | 'interrupted' — open. */
  status: string
  error?: { message: string } | null
}

/**
 * One historical turn as `thread/resume` / `thread/read {includeTurns: true}`
 * return it: the same `ThreadItem` vocabulary the live `item/completed`
 * notifications carry (so the live mapping replays it unchanged), plus an
 * `itemsView` marker ('full' | 'summary' | 'notLoaded') saying how much of
 * `items` was actually loaded. Measured against 0.146.0: both surfaces return
 * 'full' items in chronological order.
 */
export type AppServerHistoryTurn = {
  id: string
  items?: AppServerItem[]
  itemsView?: string
  status?: string
}

/**
 * One `thread/list` row (the summary Thread shape — its `turns` is always
 * empty on list responses). Timestamps are epoch **seconds** (the protocol's
 * summaries want ms). `id` is what `CreateSessionRequest.resume` feeds
 * `thread/resume`; the row's separate `sessionId` field is not it.
 */
export type AppServerThreadSummary = {
  id: string
  /** Operator-set thread name, when one exists. */
  name?: string | null
  /** First user message — the natural summary line. */
  preview?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  cwd?: string | null
  /** Ephemeral threads are never materialized on disk — not resumable. */
  ephemeral?: boolean
  gitInfo?: { branch?: string | null } | null
}

/** `thread/list` result: one page plus an opaque continuation cursor. */
export type AppServerThreadListResponse = {
  data?: AppServerThreadSummary[]
  nextCursor?: string | null
}

/**
 * One entry of `skills/list`'s `data[].skills` (codex's `SkillMetadata`).
 *
 * `interface` is the skill's own presentation block; the only field of it worth
 * carrying across the wire is `defaultPrompt` — codex's suggested opening
 * message, which is what makes a picker possible at all. The icon/brand fields
 * are TUI decoration and point at local files a browser cannot reach.
 */
export type AppServerSkillMetadata = {
  name: string
  description?: string
  /** Legacy `short_description` from SKILL.md; `interface.shortDescription` wins. */
  shortDescription?: string
  interface?: {
    displayName?: string
    shortDescription?: string
    defaultPrompt?: string
  }
  path?: string
  /** 'user' | 'repo' | 'system' | 'admin' — open. */
  scope?: string
  enabled?: boolean
}

/**
 * `skills/list` result. One entry per requested cwd (we request none, which
 * codex documents as "the session's own cwd"), each with the skills it found
 * and the manifests it could not parse. Errors are surfaced as list rows, not
 * swallowed: a skill that is present but broken is exactly what an operator
 * would otherwise spend an hour looking for.
 */
export type AppServerSkillsListResponse = {
  data?: Array<{
    cwd?: string
    skills?: AppServerSkillMetadata[]
    errors?: Array<{ path?: string; message?: string }>
  }>
}

export type AppServerUserInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }

/** `turn/plan/updated` params (v2's todo list). */
export type AppServerPlanUpdate = {
  threadId: string
  turnId: string
  plan: Array<{ step: string; status: string }>
}

// ---------------------------------------------------------------------------
// Server→client approval requests (the ask channels)
// ---------------------------------------------------------------------------

/** `item/commandExecution/requestApproval` params. Under `sandbox_approval`
 * this is an ESCALATION: the command already ran inside the sandbox and was
 * refused — `reason` is codex's own sentence ("command failed; retry without
 * sandbox?"), and accepting re-runs the command WITHOUT the sandbox.
 * `availableDecisions` is experimental (present under `experimentalApi: true`)
 * and per-request; entries are the schema's strings or structured objects
 * (`{acceptWithExecpolicyAmendment: …}`). */
export type AppServerCommandApprovalParams = {
  threadId: string
  turnId?: string
  itemId: string
  /** Distinct callback id when several approvals belong to one item. */
  approvalId?: string | null
  command?: string | null
  cwd?: string | null
  reason?: string | null
  availableDecisions?: unknown[]
}

/** `item/fileChange/requestApproval` params. */
export type AppServerFileChangeApprovalParams = {
  threadId: string
  turnId?: string
  itemId: string
  /** Root the change wants write access under, when codex names one. */
  grantRoot?: string | null
  reason?: string | null
  availableDecisions?: unknown[]
}

/** `item/permissions/requestApproval` params: the model proactively asks for a
 * permission profile (filesystem/network grants). Allowing echoes the
 * requested profile back as granted (scope defaults to 'turn'). */
export type AppServerPermissionsApprovalParams = {
  threadId: string
  turnId?: string
  itemId: string
  cwd?: string | null
  reason?: string | null
  permissions?: Record<string, unknown> | null
}

/** One `item/tool/requestUserInput` question (EXPERIMENTAL in codex's schema —
 * codex's AskUserQuestion analogue). */
export type AppServerUserInputQuestion = {
  id: string
  header?: string
  question: string
  /** Free-text answers allowed. */
  isOther?: boolean
  isSecret?: boolean
  options?: Array<{ label: string; description?: string }> | null
}

/** `item/tool/requestUserInput` params. */
export type AppServerUserInputParams = {
  threadId: string
  turnId?: string
  itemId: string
  questions: AppServerUserInputQuestion[]
  autoResolutionMs?: number | null
}

/** `mcpServer/elicitation/request` params (union over `mode`; the runner keeps
 * it structural). `turnId` is nullable — elicitations are thread-scoped. */
export type AppServerElicitationParams = {
  threadId?: string
  turnId?: string | null
  serverName?: string
  message?: string
  mode?: string
  requestedSchema?: unknown
  elicitationId?: string
  url?: string
}

// ---------------------------------------------------------------------------
// The connection seam (the `queryFn` injection pattern, at the wire level)
// ---------------------------------------------------------------------------

/**
 * One live `codex app-server` child as the runner consumes it. The real
 * implementation (`process.ts`) spawns the binary and frames JSON-RPC
 * over its stdio; unit tests inject a scripted one — no process, no
 * credentials.
 */
export type AppServerConnection = {
  /** Client→server request. Rejects on a JSON-RPC error response, a dead
   * child, or a closed connection. */
  request(method: string, params?: unknown): Promise<unknown>
  /** Client→server notification (fire and forget). */
  notify(method: string, params?: unknown): void
  /** Server→client notifications. One handler (the runner). */
  onNotification(handler: (method: string, params: unknown) => void): void
  /** Server→client REQUESTS (approvals live here): the handler's resolution is
   * sent back as the JSON-RPC result; a throw becomes an error response. `id`
   * is the wire request id — `serverRequest/resolved` names it when codex
   * settles a request on its own (auto-resolution), so the runner can retire
   * the matching pending approval instead of leaving a stale card. */
  onRequest(handler: (method: string, params: unknown, id: string | number) => Promise<unknown>): void
  /** Fires once when the child exits or the pipe breaks — NOT on `close()`.
   * The message carries an exit summary and a stderr tail for diagnostics. */
  onClose(handler: (message: string) => void): void
  /** Tear the child down (session close). Suppresses the onClose callback. */
  close(): void
}

export type AppServerConnectOptions = {
  /** Complete child environment — a provided spawn env replaces process.env,
   * never merges with it (CODEX_HOME pin already applied). */
  env: Record<string, string>
}

/** The injectable connection factory: `connectAppServer` under the resolved
 * binary in production, a scripted peer in tests. */
export type AppServerConnectFn = (options: AppServerConnectOptions) => AppServerConnection
