/**
 * Structural mirror of the `@openai/codex-sdk` surface this engine consumes.
 *
 * Local on purpose, twice over: the SDK is an optional peer dependency (these
 * types must not leak it into core's published .d.ts), and its own unions are
 * already stale against the binary it drives — the embedded model catalog
 * lists reasoning efforts (`max`, `ultra`) beyond `ModelReasoningEffort`, so
 * every open-ended axis here is a plain string. The real `Codex` class
 * satisfies {@link CodexLike} structurally; tests inject a scripted one.
 */

/** Per-turn token usage, OpenAI accounting (`turn.completed`). */
export type CodexUsage = {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

export type CodexAgentMessageItem = { id: string; type: 'agent_message'; text: string }
/** Reasoning summary, not raw CoT. */
export type CodexReasoningItem = { id: string; type: 'reasoning'; text: string }
export type CodexCommandExecutionItem = {
  id: string
  type: 'command_execution'
  command: string
  aggregated_output: string
  /** Set when the command exits; absent while running. */
  exit_code?: number
  /** 'in_progress' | 'completed' | 'failed' — open. */
  status: string
}
export type CodexFileChangeItem = {
  id: string
  type: 'file_change'
  changes: Array<{ path: string; kind: string }>
  /** Arrives as a completed/failed patch, never a proposal. */
  status: string
}
export type CodexMcpToolCallItem = {
  id: string
  type: 'mcp_tool_call'
  server: string
  tool: string
  arguments: unknown
  result?: unknown
  error?: { message: string }
  status: string
}
export type CodexWebSearchItem = { id: string; type: 'web_search'; query: string }
export type CodexTodoListItem = {
  id: string
  type: 'todo_list'
  items: Array<{ text: string; completed: boolean }>
}
/** Non-fatal by contract. */
export type CodexErrorItem = { id: string; type: 'error'; message: string }
/** Forward-compatible fallback for item types this version doesn't model —
 * not a union member (an index signature would defeat discriminant narrowing);
 * unknown items are cast to this in the mapping's default branch. */
export type CodexUnknownItem = { id: string; type: string; [key: string]: unknown }

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem

/** Top-level JSONL events of `codex exec --experimental-json`. */
export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexThreadItem }
  | { type: 'item.updated'; item: CodexThreadItem }
  | { type: 'item.completed'; item: CodexThreadItem }
  | { type: 'error'; message: string }

export type CodexUserInput =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string }

/** Options one spawn gets (a subset of the SDK's ThreadOptions, efforts open). */
export type CodexThreadOptions = {
  model?: string
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  modelReasoningEffort?: string
  approvalPolicy?: string
  networkAccessEnabled?: boolean
  additionalDirectories?: string[]
}

export type CodexTurnOptions = { signal?: AbortSignal }

export type CodexStreamedTurn = {
  events: AsyncIterable<CodexThreadEvent>
}

export type CodexThreadLike = {
  runStreamed(
    input: string | CodexUserInput[],
    turnOptions?: CodexTurnOptions,
  ): Promise<CodexStreamedTurn>
}

export type CodexLike = {
  startThread(options?: CodexThreadOptions): CodexThreadLike
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadLike
}

/**
 * Env for the codex child process. **Replace-not-merge** (verified in the SDK
 * source): when provided, the child inherits nothing from process.env — so it
 * must always be the complete session environment, never a delta. A delta
 * silently strands HOME/PATH, and the auth chain with them.
 */
export type CodexOptionsLike = {
  codexPathOverride?: string
  env?: Record<string, string>
}

/** The injectable constructor: the real SDK's `new Codex(options)` in
 * production, a scripted fake in tests (the `queryFn` pattern). */
export type CodexFactory = (options: CodexOptionsLike) => CodexLike
