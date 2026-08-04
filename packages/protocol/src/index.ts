/**
 * @workerdeck/protocol — the wire protocol between a workerdeck server and its clients.
 *
 * One session = one ordered stream of {@link SessionEvent}s (each stamped with a monotonically
 * increasing `seq`) plus a small command set ({@link SessionCommand}). Clients attach over
 * WebSocket, optionally replaying from a known `seq`, and drive the session with commands.
 *
 * This package is dependency-free and browser-safe. Anthropic API message content is modeled
 * structurally (see {@link ApiMessage}) so clients don't need the Agent SDK to render transcripts.
 */

/** Bumped on any breaking change to events, commands, or REST shapes. */
export const PROTOCOL_VERSION = 4

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * - `starting` — runner spawned, waiting for the SDK init handshake
 * - `running` — a turn is in progress
 * - `awaiting_approval` — blocked on at least one pending permission request
 * - `idle` — between turns; accepting user messages
 * - `parked` — waiting on a deferred tool execution. The live runner has been torn
 *   down and the session's state persisted; delivering the execution's result
 *   (`POST {basePath}/executions/:executionId/result`) rehydrates it under the same
 *   id and the run continues. Not terminal.
 * - `failed` — the underlying query errored; terminal
 * - `closed` — closed by a client or the host; terminal
 */
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'idle'
  | 'parked'
  | 'failed'
  | 'closed'

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

// ---------------------------------------------------------------------------
// API message content (structural mirror of Anthropic message shapes)
// ---------------------------------------------------------------------------

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>
  is_error?: boolean
}
/** Forward-compatible fallback for block types this protocol version doesn't model. */
export type UnknownBlock = { type: string; [key: string]: unknown }

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | UnknownBlock

export type ApiMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  model?: string
  stop_reason?: string | null
  /** Per-API-call token usage when the message carries it (assistant messages do).
   * Enables mid-run token accounting; result-message usage stays authoritative. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

/** A tool call promoted into a pending approval by the runner's canUseTool hook. */
export type PermissionRequest = {
  /** Server-assigned id; used by the `permission_decision` command. */
  id: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  /** Full prompt sentence from the SDK, e.g. "Claude wants to read foo.txt". */
  title?: string
  /** Short noun phrase for the tool action, e.g. "Read file". */
  displayName?: string
  /** Human-readable subtitle, e.g. "Claude will have read access to ~/x". */
  description?: string
  /** Why this permission request was triggered. */
  decisionReason?: string
  /** If raised from within a subagent, that subagent's id. */
  agentId?: string
  /** Epoch ms after which the server resolves it via its timeout policy. */
  expiresAt?: number
}

export type PermissionDecisionSource = 'client' | 'timeout' | 'policy'

// ---------------------------------------------------------------------------
// User questions (the AskUserQuestion tool)
// ---------------------------------------------------------------------------

/** One choice of an AskUserQuestion question (SDK tool-input mirror). */
export type UserQuestionOption = {
  label: string
  description?: string
  /** Optional preview content (markdown unless the session configures html)
   * rendered when the option is focused. */
  preview?: string
}

/** One question from the AskUserQuestion tool's input. By the tool's convention the
 * first option is the model's recommended choice. */
export type UserQuestion = {
  question: string
  /** Short chip/tag label (max ~12 chars), e.g. "Auth method". */
  header: string
  options: UserQuestionOption[]
  multiSelect?: boolean
}

/** How a session treats the AskUserQuestion tool:
 * - 'ask' (default) — a pending permission like any other: interactive UIs render the
 *   question form; job webhooks carry the full request so a remote controller can
 *   answer over REST (POST /sessions/:id/permissions/:requestId).
 * - 'auto' — resolved immediately with each question's first (recommended) option.
 * - 'deny' — the tool is refused with guidance to decide autonomously (unattended runs).
 * Answers ride a permission allow as `updatedInput.answers`: question text → chosen
 * option label(s), multi-select labels comma-joined — the shape the CLI's own UI uses. */
export type QuestionBehavior = 'ask' | 'auto' | 'deny'

// ---------------------------------------------------------------------------
// Session capabilities (models / slash commands the CLI reports)
// ---------------------------------------------------------------------------

/** A model the session can switch to (SDK ModelInfo mirror; fields it may grow stay unknown). */
export type ModelOption = {
  /** Model id for createSession.model / set_model. */
  value: string
  displayName: string
  description?: string
}

/** A slash command the CLI accepts as user-message text (SDK SlashCommand mirror). */
export type SlashCommandInfo = {
  /** Command name without the leading slash. */
  name: string
  description?: string
  /** Hint for arguments, e.g. "<file>". */
  argumentHint?: string
  /** Alternate names resolving to this command. */
  aliases?: string[]
}

// ---------------------------------------------------------------------------
// Usage telemetry (context window + subscription rate limits)
// ---------------------------------------------------------------------------

/** One category row from the CLI's context-usage breakdown (system prompt, tools, ...). */
export type ContextUsageCategory = {
  name: string
  tokens: number
  /** Color the CLI assigns the category. Often a CLI theme token name ('inactive',
   * 'promptBorder', ...), not a CSS color — validate before styling with it. */
  color: string
}

/** Context-window usage snapshot (SDK getContextUsage mirror), polled after each turn. */
export type ContextUsage = {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  /** Used share of the window, 0–100. */
  percentage: number
  /** Model the window sizing applies to. */
  model?: string
}

/**
 * One rate-limit window snapshot (SDK SDKRateLimitInfo mirror). Emitted only for
 * claude.ai subscription sessions — API-key sessions may never produce one, so
 * clients must render nothing (not 0%) until data arrives.
 */
export type RateLimitInfo = {
  /** 'allowed' | 'allowed_warning' | 'rejected' — kept as string, the SDK union may grow. */
  status: string
  /** Which window: 'five_hour' (session), 'seven_day' (weekly), 'seven_day_opus',
   * 'seven_day_sonnet', 'overage', ... — kept as string, the SDK union may grow. */
  rateLimitType?: string
  /** Used share of the window, 0–100. The CLI omits it on some updates — treat
   * absent as unknown, not 0. */
  utilization?: number
  /** Epoch **seconds** when the window resets (render countdowns client-side). */
  resetsAt?: number
  isUsingOverage?: boolean
}

// ---------------------------------------------------------------------------
// Tool execution (bridged, deferred, and remote)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one tool execution, correlated by `executionId` end to end.
 *
 * - `pending` — dispatched, result not in yet (bridged to a client, or queued).
 * - `deferred` — parked beyond this turn/process; may outlive the session's
 *   liveness and be applied on rehydration.
 * - `settled` / `failed` — terminal. Results are applied idempotently by id, so
 *   a duplicate delivery is a no-op rather than a second application.
 */
export type ToolExecutionStatus = 'pending' | 'deferred' | 'settled' | 'failed'

/** Where a tool execution ran (or is running). Advisory: for display and routing. */
export type ToolExecutionBackend = 'server' | 'browser' | 'managed' | 'remote'

/** Result payload of a tool execution, by value — never a live host reference. */
export type ToolExecutionOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }

// ---------------------------------------------------------------------------
// Session events (server -> client)
// ---------------------------------------------------------------------------

export type SessionEventBody =
  /** SDK init handshake: what this session actually is. */
  | {
      type: 'system_init'
      sdkSessionId: string
      model: string
      cwd: string
      /** Where the session's Anthropic auth came from: 'oauth' means a claude.ai
       * subscription login; other values ('user' | 'project' | 'org' | 'temporary')
       * are API-key provenance. Kept as string — the SDK union may grow. */
      apiKeySource: string
      tools: string[]
      skills: string[]
      slashCommands: string[]
      permissionMode: PermissionMode
      claudeCodeVersion: string
      mcpServers: Array<{ name: string; status: string }>
    }
  | { type: 'status_changed'; status: SessionStatus; detail?: string }
  /** Models and slash commands available to this session; fetched from the CLI after
   * init. Late attachers get it via replay like any other event. */
  | { type: 'capabilities'; models: ModelOption[]; commands: SlashCommandInfo[] }
  /** The session's model changed via `set_model`. `model` undefined = back to default. */
  | { type: 'model_changed'; model?: string }
  /** The session's permission mode changed via `set_permission_mode`. */
  | { type: 'permission_mode_changed'; mode: PermissionMode }
  /** Context-window usage snapshot; the runner polls it after each turn. */
  | { type: 'context_usage'; usage: ContextUsage }
  /** Subscription rate-limit update for one window (see {@link RateLimitInfo}). */
  | { type: 'rate_limit'; info: RateLimitInfo }
  | {
      type: 'assistant_message'
      message: ApiMessage
      /** Set when the message was produced inside a subagent (Task tool). */
      parentToolUseId: string | null
      /** True when backfilled from a resumed session's history. */
      replay?: boolean
      uuid: string
    }
  | {
      type: 'user_message'
      message: ApiMessage
      parentToolUseId: string | null
      /** True when replayed from a resumed session's history. */
      replay?: boolean
      /** True for tool results and other synthetic user-role messages. */
      synthetic?: boolean
      uuid?: string
    }
  /** Raw Anthropic streaming event (message_start/content_block_delta/...); emitted only
   * when the session was created with `includePartialMessages`. */
  | {
      type: 'stream_delta'
      event: { type: string; [key: string]: unknown }
      parentToolUseId: string | null
      uuid: string
    }
  | {
      type: 'turn_result'
      subtype:
        | 'success'
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries'
      isError: boolean
      durationMs: number
      numTurns: number
      totalCostUsd: number
      /** Final text of the turn (success only). */
      result?: string
      errors?: string[]
      usage?: unknown
    }
  | { type: 'permission_requested'; request: PermissionRequest }
  | {
      type: 'permission_resolved'
      requestId: string
      behavior: 'allow' | 'deny'
      resolvedBy: PermissionDecisionSource
      /** Denial message, when denied. */
      message?: string
    }
  /** A tool execution was dispatched to a backend. For bridged executions this
   * precedes the `tool_call_request` frame; for deferred ones it is the record
   * that survives a teardown. */
  | {
      type: 'execution_dispatched'
      executionId: string
      toolName: string
      backend: ToolExecutionBackend
      /** True when the execution may outlive this turn or process. */
      deferred?: boolean
      /** Epoch ms after which the server applies its timeout policy. */
      expiresAt?: number
    }
  /** A dispatched execution produced a result. Applied idempotently by `executionId`. */
  | {
      type: 'execution_result'
      executionId: string
      output: ToolExecutionOutput
      /** Guest/agent-visible logs, if the backend captured any. */
      logs?: string[]
      durationMs?: number
    }
  /** A dispatched execution failed, timed out, or was orphaned. The failure is fed
   * back into the loop as tool output so the agent can adapt — it is not a session error. */
  | {
      type: 'execution_failed'
      executionId: string
      /** Machine-readable cause: 'timeout' | 'oom' | 'exception' | 'orphaned' | backend-specific. */
      reason: string
      error: string
      logs?: string[]
      durationMs?: number
    }
  /** The agent handed over a file from its session scratch filesystem (the
   * `deliver_file` tool). Download it via `GET {basePath}/sessions/:id/files/<path>`
   * for as long as the session lives (the VFS is in-memory). */
  | { type: 'file_delivered'; path: string; bytes: number; description?: string }
  /** Any SDKMessage this protocol version doesn't model first-class (task progress,
   * compaction boundaries, auth status, ...). Payload is the raw SDK message. */
  | { type: 'sdk_event'; payload: { type: string; [key: string]: unknown } }
  | { type: 'session_error'; message: string }
  | { type: 'session_closed'; reason: 'client' | 'server' | 'error' }

export type SessionEvent = SessionEventBody & {
  /** Monotonic per-session sequence number, starting at 1. */
  seq: number
  /** Epoch ms when the server emitted the event. */
  ts: number
}

// ---------------------------------------------------------------------------
// Commands (client -> server)
// ---------------------------------------------------------------------------

export type SessionCommand =
  | { type: 'user_message'; text: string }
  | {
      type: 'permission_decision'
      requestId: string
      behavior: 'allow' | 'deny'
      /** allow only: modified tool input to run instead of the original. */
      updatedInput?: Record<string, unknown>
      /** deny only: reason surfaced to the model. */
      message?: string
      /** deny only: also interrupt the running turn. */
      interrupt?: boolean
    }
  | { type: 'interrupt' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  /** Switch the model for subsequent responses; omit `model` for the default. */
  | { type: 'set_model'; model?: string }
  /**
   * Result of a tool execution the server bridged to this client (see
   * {@link ToolCallRequestFrame}). Unknown or already-settled `executionId`s are
   * ignored — delivery is idempotent, and a late result after a timeout must not
   * re-open a settled call.
   *
   * Browser-returned results are UNTRUSTED input: acceptable for the user's own
   * data, never a source for server-authoritative state.
   */
  | {
      type: 'tool_call_result'
      executionId: string
      output: ToolExecutionOutput
      logs?: string[]
    }
  /** The client could not execute a bridged call (unsupported tool, guest error,
   * tab closing). Fed back to the agent as tool output. */
  | {
      type: 'tool_call_error'
      executionId: string
      reason: string
      error: string
      logs?: string[]
    }
  | { type: 'close' }

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

/** First frame the server sends after a successful attach. */
export type AttachedFrame = {
  type: 'attached'
  protocolVersion: number
  session: SessionInfo
  /** Events with seq > the client's `afterSeq` follow as `event` frames. */
  replayingFrom: number
}

/**
 * Ask the attached client to execute a tool call in its own sandbox (browser
 * bridge). The client answers with `tool_call_result` or `tool_call_error`
 * carrying the same `executionId`.
 *
 * Only sandbox-benefiting tools are ever bridged. Authenticated/authoritative
 * tools (MCP, secret-bearing APIs) execute server-side and never appear here.
 */
export type ToolCallRequestFrame = {
  type: 'tool_call_request'
  executionId: string
  toolName: string
  input: unknown
  /** Files to seed the client's scratch VFS with, path → contents. */
  vfsSeed?: Record<string, string>
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /** Epoch ms after which the server gives up and fails the execution. */
  expiresAt?: number
}

export type ServerFrame =
  | AttachedFrame
  | { type: 'event'; event: SessionEvent }
  | ToolCallRequestFrame
  /** A bridged execution no longer needs an answer (turn interrupted, timed out,
   * or the session closed) — the client should abandon it. */
  | { type: 'tool_call_canceled'; executionId: string; reason: string }
  | { type: 'protocol_error'; message: string }

export type ClientFrame = SessionCommand

// ---------------------------------------------------------------------------
// Profiles (named Claude Code config directories)
// ---------------------------------------------------------------------------

/** Per-profile fallbacks filled into session/job requests that leave the field
 * unset. Defaults, not enforced caps — an explicit request value always wins. */
export type ProfileDefaults = {
  model?: string
  permissionMode?: PermissionMode
}

/**
 * A named Claude Code config directory sessions can run under: the session's CLI
 * process gets it as CLAUDE_CONFIG_DIR, so the profile carries that directory's
 * settings, memory, skills, and whatever credentials the SDK/CLI resolves from it.
 * Profiles are declared in server options at startup (or a 'default' one is
 * auto-created from the operator's own config dir) — the API only reads them.
 */
/**
 * Which engine a profile runs on.
 * - `claude` (default) — Claude Code via the Agent SDK, configured by a config dir.
 * - `provider` — a model-agnostic provider (OpenAI-compatible, Anthropic, Moonshot),
 *   configured by provider id and credentials from the operator's environment.
 */
export type ProfileEngine = 'claude' | 'provider'

/**
 * Permission modes the model-agnostic provider engine understands. The rest of
 * {@link PermissionMode}'s vocabulary is Claude Code's: `acceptEdits`, `plan` and
 * `auto` name CLI-side behaviours a provider session has no equivalent of.
 */
export const PROVIDER_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'bypassPermissions',
  'dontAsk',
]

/**
 * Whether a profile's engine can run a permission mode. The single source of
 * truth for the restriction: create forms filter what they offer with it, the
 * gateway rejects with it. An absent `engine` means 'claude' (every mode).
 */
export function supportsPermissionMode(
  engine: ProfileEngine | undefined,
  mode: PermissionMode,
): boolean {
  return engine === 'provider' ? PROVIDER_PERMISSION_MODES.includes(mode) : true
}

/**
 * A model provider a `provider` profile can run on. Credentials are ALWAYS
 * resolved from the operator's environment — never carried on the wire, never
 * stored here. `apiKeyEnv` names the variable to read, it does not hold a key.
 */
export type ProviderConfig = {
  /** Provider adapter to use, e.g. 'anthropic' | 'openai' | 'moonshotai' |
   * 'openai-compatible'. Kept as a string: the set is host-extensible. */
  id: string
  /** Default model id, e.g. 'kimi-k3'. Overridable per session. */
  model?: string
  /** Model ids this profile offers, for the dashboard's picker. Operator-declared
   * rather than discovered: provider engines have no equivalent of the CLI's
   * `supportedModels()`, and only the operator knows which ids their endpoint and
   * key actually serve. Unset → the picker offers {@link ProviderConfig.model} alone. */
  models?: string[]
  /** Base URL for OpenAI-compatible providers. */
  baseUrl?: string
  /** Environment variable the operator put the key in. Never the key itself. */
  apiKeyEnv?: string
}

/**
 * A grantable capability of the model-agnostic engine, named after the tool it
 * yields. The always-present tools (`fs_*`, `eval_script`) are not listed: they
 * are the engine's scratch filesystem and sandbox, not a grant.
 */
export type SessionCapability = 'web_search' | 'download' | 'web_fetch' | 'deliver_file'

/**
 * What sessions under a `provider` profile get, declared by the operator. Meaning-
 * less for `claude` profiles, whose equivalents live in the config directory.
 *
 * MCP servers are named, never configured, here: a server's transport config can
 * carry credentials in its headers, and this type is served by `GET /profiles`.
 * The names refer to servers the host connected in `createEngineRunner`, which is
 * where the configs (and the credentials) stay.
 */
export type ProfileSessionDefaults = {
  /** Capabilities granted to sessions under this profile. Absent = no
   * declaration, so a session gets whatever backends the host wired. A session
   * request may narrow this set, never widen it. */
  capabilities?: SessionCapability[]
  /** MCP servers, by name, whose tools sessions under this profile may use.
   * Absent = no declaration (every server the host connected). */
  mcpServers?: string[]
  /** Prepended to the session's system prompt. */
  instructions?: string
}

export type ProfileInfo = {
  /** Unique name, used as {@link CreateSessionRequest.profile}. */
  name: string
  /** Engine this profile runs on. Defaults to 'claude' when absent, so profiles
   * written before provider support keep working unchanged. */
  engine?: ProfileEngine
  /** Absolute path set as CLAUDE_CONFIG_DIR for the session's CLI process.
   * Required for 'claude' profiles; meaningless for 'provider' ones. */
  configDir?: string
  /** Provider wiring for 'provider' profiles. */
  provider?: ProviderConfig
  description?: string
  defaults?: ProfileDefaults
  /** Provider-engine session grants (capabilities, MCP servers, instructions). */
  session?: ProfileSessionDefaults
  /** Response-only, computed by the server: this profile came from the profile
   * store and can be edited or deleted through the API. Profiles declared in
   * server options are absent/false — they are code. Ignored on the way in. */
  managed?: boolean
}

/**
 * Curated, read-only snapshot of what a profile's config directory contains —
 * the parts relevant to running worker sessions. Values that could carry secrets
 * (env var values) never leave the server; only names are listed.
 */
export type ProfileConfigSnapshot = {
  /** From the config dir's settings.json; absent when missing or unparseable. */
  settings?: {
    /** Configured default model. */
    model?: string
    /** permissions.defaultMode — the CLI's default permission mode. */
    defaultPermissionMode?: string
    /** Rule counts from permissions.allow / ask / deny. */
    permissionRules?: { allow: number; ask: number; deny: number }
    /** Env var NAMES declared in settings.json env (values never included). */
    envKeys?: string[]
    /** Hook event names with at least one hook configured. */
    hooks?: string[]
  }
  /** CLAUDE.md (user memory) present in the config dir. */
  hasUserMemory: boolean
  /** Skill names (skills/<name>/). */
  skills: string[]
  /** Agent names (agents/<name>.md). */
  agents: string[]
  /** Custom slash-command names (commands/<name>.md). */
  commands: string[]
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

export type McpServerConfigWire =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

export type CreateSessionRequest = {
  /** Directory the session is rooted at. Required: `cwd` is per-query in the SDK
   * and the server re-pins it on every call. */
  cwd: string
  /** Profile (named Claude Code config dir) to run under. Required when the server
   * declares more than one profile; implicit when exactly one exists. */
  profile?: string
  /** Optional initial prompt (may be a skill invocation like "/verify-content 123"). */
  prompt?: string
  permissionMode?: PermissionMode
  /** Pre-authorize 'bypassPermissions' (the CLI's --dangerously-skip-permissions
   * capability) so the mode can be switched on mid-session. Without it the CLI
   * rejects `set_permission_mode: 'bypassPermissions'` on a running session.
   * Implied when `permissionMode` is already 'bypassPermissions'. */
  allowDangerouslySkipPermissions?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfigWire>
  /** Which filesystem settings the session loads. Include 'project' to pick up the
   * target repo's skills and CLAUDE.md ("close-to-real" fidelity). */
  settingSources?: Array<'user' | 'project' | 'local'>
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  /** Resume an existing SDK session by id. */
  resume?: string
  /** With `resume`: fork to a new session id instead of continuing. */
  forkSession?: boolean
  /** Emit `stream_delta` events for token-by-token rendering. Default true. */
  includePartialMessages?: boolean
  /** Per-session override of the server's permission-request timeout (ms). */
  approvalTimeoutMs?: number
  /** AskUserQuestion handling (see {@link QuestionBehavior}). Default 'ask'. */
  questionBehavior?: QuestionBehavior
  /** Provider engine only: run with fewer capabilities than the profile grants
   * (see {@link ProfileSessionDefaults.capabilities}). Narrowing only — naming a
   * capability the profile does not grant is a 400, not a silent upgrade. */
  capabilities?: SessionCapability[]
  /** Free-form metadata echoed back on SessionInfo (host app bookkeeping). */
  meta?: Record<string, unknown>
}

export type SessionInfo = {
  /** Server-assigned id (stable across SDK session forks/resumes). */
  id: string
  /** Underlying Agent SDK session id, once known; use for `resume`. */
  sdkSessionId?: string
  status: SessionStatus
  cwd: string
  /** Profile the session runs under (resolved name, present even when implicit). */
  profile?: string
  /** Engine actually running this session, reported by the runner itself. Lets a
   * session surface gate CLI-only affordances (permission modes, context usage,
   * rate limits) without looking the profile back up. Absent = 'claude'. */
  engine?: ProfileEngine
  model?: string
  permissionMode?: PermissionMode
  /** See the `system_init` event; 'oauth' = claude.ai subscription credentials. */
  apiKeySource?: string
  createdAt: number
  /** Highest event seq emitted so far; attach with `afterSeq` to catch up. */
  lastSeq: number
  pendingPermissionCount: number
  meta?: Record<string, unknown>
  /** Display title: `meta.title` if the host set one, else derived (e.g. first prompt). */
  title?: string
  /** Cumulative cost across all turns so far (sum of turn_result totals). */
  totalCostUsd?: number
  /** Cumulative turn count across the session. */
  numTurns?: number
  /** Epoch ms of the most recent emitted event. */
  lastActivityAt?: number
}

/**
 * A session in the Agent SDK's on-disk store (independent of this server's registry).
 * Listed so hosts can offer "resume" across server restarts: feed `sessionId` to
 * CreateSessionRequest.resume. Mirrors the SDK's SDKSessionInfo, kept browser-safe.
 */
export type SdkSessionSummary = {
  sessionId: string
  /** Custom title, auto summary, or first prompt — whichever the SDK has. */
  summary: string
  /** Epoch ms of last modification. */
  lastModified: number
  createdAt?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
}

/** One deliverable in the session's scratch filesystem (see the `file_delivered` event). */
export type SessionFileInfo = { path: string; bytes: number }
/** `GET {basePath}/sessions/:id/files` — every file currently in the session's VFS.
 * `GET {basePath}/sessions/:id/files/<path>` downloads one (attachment disposition).
 * 404 when the session's engine exposes no VFS (Claude-engine sessions). */
export type ListSessionFilesResponse = { files: SessionFileInfo[] }
export type ListSessionsResponse = { sessions: SessionInfo[] }
export type CreateSessionResponse = { session: SessionInfo }
export type GetSessionResponse = { session: SessionInfo }

/** Body of `POST {basePath}/sessions/:id/permissions/:requestId` — the REST counterpart
 * of the WS `permission_decision` command, for remote controllers without a socket
 * (e.g. answering a job's AskUserQuestion from a webhook consumer). 404 = the request
 * is unknown, already resolved, or expired. */
export type ResolvePermissionRequest =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
export type ResolvePermissionResponse = { resolved: true }

/**
 * Body of `POST {basePath}/executions/:executionId/result` — the way a deferred
 * executor (a remote worker, a batch job, a human) delivers the outcome of an
 * execution the session parked on. The session is rehydrated if its runner was
 * torn down, and the result is folded back into the agent loop; a `failed` result
 * is ordinary tool output the agent adapts to, not a session error.
 *
 * Applied **idempotently by `executionId`**: a duplicate or late delivery (one
 * racing the execution watchdog) answers 200 with `applied: false` rather than
 * erroring or applying twice. 404 means no session is parked on that id.
 */
export type SubmitExecutionResultRequest =
  | { status: 'ok'; output: ToolExecutionOutput; logs?: string[] }
  | { status: 'failed'; reason: string; error: string; logs?: string[] }
export type SubmitExecutionResultResponse = {
  /** False when the id was already settled — the delivery was a no-op. */
  applied: boolean
  /** Session the execution belonged to. */
  sessionId: string
}

export type ListSdkSessionsResponse = { sdkSessions: SdkSessionSummary[] }
/** `GET {basePath}/profiles` — filtered to the profiles the caller may use. */
export type ListProfilesResponse = {
  profiles: ProfileInfo[]
  /** Whether this caller may create profiles here — true only when the server has
   * a profile store AND the principal carries `canManageProfiles`. Lets a UI hide
   * controls that would always be refused. */
  canManage?: boolean
}

/**
 * `POST {basePath}/profiles` — create a managed profile. Available only when the
 * server was given a profile store, and only to a principal with
 * `canManageProfiles`. Profiles declared in server options are code, not data:
 * they cannot be created, edited, or deleted through these routes.
 */
export type CreateProfileRequest = ProfileInfo

/** `PATCH {basePath}/profiles/:name` — merge into a managed profile. The name is
 * the route, not the body; pass `null` to clear an optional field. */
export type UpdateProfileRequest = Omit<Partial<ProfileInfo>, 'name'>

export type SaveProfileResponse = { profile: ProfileInfo }
/** `GET {basePath}/profiles/:name` — the profile plus a fresh config snapshot. */
export type GetProfileResponse = { profile: ProfileInfo; config: ProfileConfigSnapshot }
export type ErrorResponse = { error: string }

// ---------------------------------------------------------------------------
// Session notifications (the out-of-band "something wants you" channel)
// ---------------------------------------------------------------------------

/**
 * The moments in an *interactive* session a person needs to hear about when they
 * are not watching it — the whole point being that a phone cannot hold a
 * WebSocket open in the background, so the server has to reach out.
 *
 * Deliberately four: this is a human-attention channel, not an event mirror. The
 * event log stays on the session WS (attach with `afterSeq` to catch up); if you
 * want every assistant message, subscribe there instead.
 */
export type SessionNotificationType =
  /** The agent is blocked on an approval — the one that matters most. */
  | 'permission_requested'
  /** A turn finished; the session is idle and waiting for the human. */
  | 'turn_completed'
  /** The session failed (`session_error`). */
  | 'session_error'
  /** The session ended (`session_closed`), whoever ended it. */
  | 'session_closed'

/** One delivery on the session-notification channel (JSON body of a webhook POST). */
export type SessionNotification = {
  type: SessionNotificationType
  sessionId: string
  /** Snapshot at notification time — status, title, cwd, cost, `lastSeq`. */
  session: SessionInfo
  /** Seq of the event behind this notification; attach with `afterSeq: seq - 1` to
   * land on it. */
  seq: number
  ts: number
  /** One line fit for a notification body: the permission title, the turn's final
   * text, the error message. */
  preview?: string
  /** `permission_requested` only: the full request, so a consumer can answer it via
   * `POST {basePath}/sessions/:id/permissions/:requestId` — which is what makes an
   * Approve/Deny action on a lock-screen notification possible. */
  request?: PermissionRequest
  /** `turn_completed` only. */
  result?: { isError: boolean; durationMs: number; numTurns: number; totalCostUsd: number }
  /** `session_closed` only. */
  reason?: 'client' | 'server' | 'error'
}

/** Where session notifications are POSTed (JSON body = {@link SessionNotification}).
 * Server-wide, not per session: the point is to hear about sessions you did not
 * create yourself and are not attached to. */
export type SessionWebhookConfig = {
  url: string
  /** Extra headers sent with every delivery (auth tokens etc.). */
  headers?: Record<string, string>
  /** Types to deliver. Default: all of them. */
  events?: SessionNotificationType[]
}

// ---------------------------------------------------------------------------
// Job queue (one-shot scheduled runs over the session runner)
// ---------------------------------------------------------------------------

/**
 * - `queued` — accepted, waiting for a concurrency slot (or the daily token budget)
 * - `running` — a session is executing the prompt
 * - `parked` — waiting on an external event (a deferred tool execution). Not
 *   terminal and not consuming a concurrency slot; resumes to `running` when the
 *   result arrives, or fails via the execution watchdog if it never does.
 * - `succeeded` / `failed` — terminal; `result` (and `error` on failure) are set
 * - `canceled` — terminal; canceled by a client before or during the run
 */
export type JobStatus = 'queued' | 'running' | 'parked' | 'succeeded' | 'failed' | 'canceled'

/** Where job progress/completion deliveries are POSTed (JSON body = {@link JobEvent}). */
export type WebhookConfig = {
  url: string
  /** Extra headers sent with every delivery (auth tokens etc.). */
  headers?: Record<string, string>
  /** Delivery granularity: 'messages' also POSTs job_progress per assistant message /
   * permission request; 'completion' only job_started + job_completed. Default 'messages'. */
  progress?: 'messages' | 'completion'
}

/**
 * Schedule a one-shot run: the session executes `prompt` unattended and the job
 * completes with that run's result. `session.prompt` is the task and is required;
 * `resume`/`forkSession` are not supported for queued jobs.
 */
export type CreateJobRequest = {
  session: CreateSessionRequest & { prompt: string }
  webhook?: WebhookConfig
  /** Per-job token cap; the effective cap is min(this, the server's sessionTokenLimit). */
  maxTokens?: number
  /** Per-job wall-clock cap; the effective cap is min(this, the server's maxJobDurationMs). */
  maxDurationMs?: number
  /** Total run attempts: failed (not canceled) runs re-queue until this many attempts
   * have been made. Default 1 (no retries). */
  attempts?: number
  /** Delay before the first retry, doubled for each subsequent one. Default 5000. */
  retryDelayMs?: number
  /** Host bookkeeping echoed back on JobInfo. */
  meta?: Record<string, unknown>
}

/** Cumulative resource usage of a job's run. `tokens` counts input + output +
 * cache-creation + cache-read tokens across all turns. */
export type JobUsage = {
  tokens: number
  totalCostUsd: number
  numTurns: number
}

/** Terminal outcome of the job's run (mirrors the final turn_result). */
export type JobResult = {
  subtype: string
  isError: boolean
  /** Final text of the run (success only). */
  result?: string
  errors?: string[]
  durationMs: number
}

export type JobInfo = {
  id: string
  status: JobStatus
  cwd: string
  /** Profile the run executes under (resolved name, present even when implicit). */
  profile?: string
  prompt: string
  /** Server session id once started — attach via the sessions WS to watch the run live. */
  sessionId?: string
  sdkSessionId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** 1-based run attempt this info reflects. */
  attempt?: number
  /** Total attempts configured on the request (see CreateJobRequest.attempts). */
  maxAttempts?: number
  /** For a job re-queued by retry backoff: earliest time the next attempt may start. */
  nextRunAt?: number
  /** Set while `status` is 'parked': when the run parked, and the execution it is
   * waiting on — the id to POST a result to. Cleared when it resumes. */
  parkedAt?: number
  parkedExecutionId?: string
  /** Cumulative across attempts. */
  usage: JobUsage
  result?: JobResult
  /** Failure or cancellation reason (for a queued retry: the previous attempt's error). */
  error?: string
  meta?: Record<string, unknown>
}

/** Latest mid-run activity, carried on job_progress deliveries. */
export type JobProgress = {
  kind: 'assistant_text' | 'tool_use' | 'permission_requested' | 'permission_resolved'
  /** Short human-readable preview (message excerpt, tool name, permission title). */
  preview?: string
  /** 'permission_requested' only: the full request (including AskUserQuestion input) so
   * webhook consumers can answer via POST /sessions/:sessionId/permissions/:requestId. */
  request?: PermissionRequest
}

/** Webhook delivery payload (also the queue's local event shape). `job_submitted` goes
 * to local observers and the queue WS only — the submitter already has the POST
 * response, so webhooks start at `job_started`. `job_retrying` marks a failed run that
 * was re-queued (`job.nextRunAt` says when); `job_completed` is always terminal. */
export type JobEvent =
  | { type: 'job_submitted'; job: JobInfo; ts: number }
  | { type: 'job_started'; job: JobInfo; ts: number }
  | { type: 'job_progress'; job: JobInfo; progress: JobProgress; ts: number }
  /** The run parked on a deferred execution; `executionId` says what it waits on —
   * the id to POST a result to. The *work itself* (tool name, input, VFS seed) went
   * to the executor's own dispatch hook, not over this channel: a webhook consumer
   * learns that a run is waiting, the worker learns what to do. */
  | { type: 'job_parked'; job: JobInfo; executionId: string; ts: number }
  /** A parked run resumed because its execution result arrived. */
  | { type: 'job_resumed'; job: JobInfo; executionId: string; ts: number }
  | { type: 'job_retrying'; job: JobInfo; ts: number }
  | { type: 'job_completed'; job: JobInfo; ts: number }

export type QueueStats = {
  maxConcurrency: number
  running: number
  queued: number
  /** Jobs waiting on a deferred execution. They hold no concurrency slot and
   * their wall-clock budget is not ticking. */
  parked: number
  sessionTokenLimit?: number
  dailyTokenLimit?: number
  /** Tokens consumed by queue jobs in the current UTC day. */
  dailyTokensUsed: number
  /** True when the daily budget is exhausted and queued jobs are being held. */
  paused: boolean
}

/** Frames sent on the queue WS (`{basePath}/queue/ws`). The stream is one-way
 * (server→client): every job's lifecycle as it happens, plus refreshed stats after
 * lifecycle changes. Clients send nothing; job mutations stay on REST. */
export type QueueServerFrame =
  | { type: 'queue_attached'; protocolVersion: number; stats: QueueStats }
  | { type: 'job_event'; event: JobEvent }
  | { type: 'queue_stats'; stats: QueueStats }

export type CreateJobResponse = { job: JobInfo }
export type GetJobResponse = { job: JobInfo }
export type ListJobsResponse = { jobs: JobInfo[] }
export type QueueStatsResponse = { stats: QueueStats }
