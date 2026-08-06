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
  | AppServerUserMessageItem

/** The `Turn` object of `turn/started` / `turn/completed`. */
export type AppServerTurn = {
  id: string
  /** 'inProgress' | 'completed' | 'failed' | 'interrupted' — open. */
  status: string
  error?: { message: string } | null
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
   * sent back as the JSON-RPC result; a throw becomes an error response. */
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void
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
