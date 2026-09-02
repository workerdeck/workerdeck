export const PROTOCOL_VERSION = 1

export type SessionStatus = 'starting' | 'running' | 'awaiting_approval' | 'idle' | 'parked' | 'failed' | 'closed'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>
  is_error?: boolean
  truncated?: boolean
  total_chars?: number
}

export const TOOL_RESULT_HEAD_CHARS = 8_000

export type ImageRefPart = {
  type: 'image_ref'
  media_type: string
  bytes: number
  part_index: number
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

export function imagePartRef(part: { type?: string; [key: string]: unknown }, index: number): ImageRefPart | undefined {
  if (part.type !== 'image') {
    return undefined
  }
  const source = part.source as { type?: string; data?: unknown; media_type?: unknown } | undefined
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') {
    return undefined
  }
  return {
    type: 'image_ref',
    media_type: typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream',
    bytes: base64Bytes(source.data),
    part_index: index,
  }
}

export type UnknownBlock = { type: string; [key: string]: unknown }

export type PatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type FilePatch = {
  path?: string
  kind?: 'create' | 'update'
  hunks: PatchHunk[]
  truncated?: boolean
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | UnknownBlock

export type MessageAttachment = {
  id: string
  name: string
  mediaType: string
  bytes: number
}

export type ApiMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  model?: string
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type PermissionRequest = {
  id: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  agentId?: string
  expiresAt?: number
}

export type PermissionDecisionSource = 'client' | 'timeout' | 'policy'

export type UserQuestionOption = {
  label: string
  description?: string
  preview?: string
}

export type UserQuestion = {
  question: string
  header: string
  options: UserQuestionOption[]
  multiSelect?: boolean
}

export type QuestionBehavior = 'ask' | 'auto' | 'deny'

export type ModelOption = {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  primary?: boolean
  reasoningEfforts?: readonly string[]
}

export type SkillInfo = {
  name: string
  description?: string
  shortDescription?: string
  displayName?: string
  defaultPrompt?: string
  scope?: string
  enabled: boolean
}

export type SlashCommandInfo = {
  name: string
  description?: string
  argumentHint?: string
  aliases?: string[]
}

export type ContextUsageCategory = {
  name: string
  tokens: number
  color: string
}

export type ContextUsage = {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
}

export type ContextReading = {
  totalTokens: number
  maxTokens: number
  percentage: number
}

export type RateLimitInfo = {
  status: string
  rateLimitType?: string
  utilization?: number
  resetsAt?: number
  isUsingOverage?: boolean
}

export type ToolExecutionStatus = 'pending' | 'deferred' | 'settled' | 'failed'

export type ToolExecutionBackend = 'server' | 'browser' | 'managed' | 'remote'

export type ToolExecutionOutput = { type: 'text'; value: string } | { type: 'json'; value: unknown }

export type SessionEventBody =
  | {
      type: 'system_init'
      sdkSessionId: string
      model: string
      cwd: string
      apiKeySource: string
      tools: string[]
      skills: string[]
      slashCommands: string[]
      permissionMode: PermissionMode
      claudeCodeVersion: string
      mcpServers: Array<{ name: string; status: string }>
    }
  | { type: 'status_changed'; status: SessionStatus; detail?: string }
  | {
      type: 'capabilities'
      models: ModelOption[]
      commands: SlashCommandInfo[]
      defaultModel?: string
    }
  | { type: 'skills'; skills: SkillInfo[] }
  | {
      type: 'file_produced'
      fileId: string
      path: string
      mediaType?: string
      bytes?: number
      toolUseId?: string
    }
  | { type: 'model_changed'; model?: string }
  | { type: 'permission_mode_changed'; mode: PermissionMode }
  | { type: 'context_usage'; usage: ContextUsage }
  | { type: 'rate_limit'; info: RateLimitInfo }
  | { type: 'plan_info'; subscriptionType: string }
  | {
      type: 'conversation_reset'
      sdkSessionId?: string
    }
  | {
      type: 'context_compacted'
      uuid: string
      parentToolUseId?: string | null
    }
  | {
      type: 'assistant_message'
      message: ApiMessage
      parentToolUseId: string | null
      replay?: boolean
      uuid: string
    }
  | {
      type: 'user_message'
      message: ApiMessage
      parentToolUseId: string | null
      replay?: boolean
      synthetic?: boolean
      attachments?: MessageAttachment[]
      patch?: FilePatch
      uuid?: string
    }
  | {
      type: 'stream_delta'
      event: { type: string; [key: string]: unknown }
      parentToolUseId: string | null
      uuid: string
    }
  | {
      type: 'turn_result'
      subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'
      isError: boolean
      durationMs: number
      numTurns: number
      totalCostUsd: number
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
      message?: string
    }
  | {
      type: 'execution_dispatched'
      executionId: string
      toolName: string
      backend: ToolExecutionBackend
      deferred?: boolean
      expiresAt?: number
    }
  | {
      type: 'execution_result'
      executionId: string
      output: ToolExecutionOutput
      logs?: string[]
      durationMs?: number
    }
  | {
      type: 'execution_failed'
      executionId: string
      reason: string
      error: string
      logs?: string[]
      durationMs?: number
    }
  | { type: 'file_delivered'; path: string; bytes: number; description?: string }
  | { type: 'sdk_event'; payload: { type: string; [key: string]: unknown } }
  | { type: 'session_error'; message: string }
  | { type: 'session_closed'; reason: 'client' | 'server' | 'error' }

export type SessionEvent = SessionEventBody & {
  seq: number
  ts: number
}

export type SessionCommand =
  | {
      type: 'user_message'
      text: string
      attachmentIds?: string[]
    }
  | {
      type: 'permission_decision'
      requestId: string
      behavior: 'allow' | 'deny'
      updatedInput?: Record<string, unknown>
      message?: string
      interrupt?: boolean
    }
  | { type: 'interrupt' }
  | { type: 'clear_context' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'set_model'; model?: string }
  | {
      type: 'tool_call_result'
      executionId: string
      output: ToolExecutionOutput
      logs?: string[]
    }
  | {
      type: 'tool_call_error'
      executionId: string
      reason: string
      error: string
      logs?: string[]
    }
  | { type: 'close' }

export type AttachedFrame = {
  type: 'attached'
  protocolVersion: number
  session: SessionInfo
  replayingFrom: number
}

export type ToolCallRequestFrame = {
  type: 'tool_call_request'
  executionId: string
  toolName: string
  input: unknown
  vfsSeed?: Record<string, string>
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  expiresAt?: number
}

export type ServerFrame =
  | AttachedFrame
  | { type: 'event'; event: SessionEvent }
  | ToolCallRequestFrame
  | { type: 'tool_call_canceled'; executionId: string; reason: string }
  | { type: 'protocol_error'; message: string }

export type ClientFrame = SessionCommand

export type ProfileDefaults = {
  model?: string
  permissionMode?: PermissionMode
}

export type ProfileEngine = 'claude' | 'codex' | 'provider'

export type EngineCapabilities = {
  interactiveApprovals: boolean
  permissionModes: readonly PermissionMode[]
  defaultPermissionMode: PermissionMode
  resume: boolean
  resumeBackfill: boolean
  listSessions: boolean
  contextUsage: boolean
  rateLimits: boolean
  mcpStatus: boolean
  mcpServerActions: boolean
  sessionMcpServers: boolean
  slashCommands: boolean
  clearContext?: boolean
  skillsList: boolean
  settingSources: boolean
  budgets: boolean
  attachments: ReadonlyArray<'image' | 'pdf' | 'text'>
  reasoningEfforts?: readonly string[]
  vfs: boolean
  hostCwd?: boolean
  streaming: 'token' | 'item' | 'none'
}

export const ENGINE_CAPABILITIES: Record<ProfileEngine, EngineCapabilities> = {
  claude: {
    interactiveApprovals: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'],
    defaultPermissionMode: 'default',
    resume: true,
    resumeBackfill: true,
    listSessions: true,
    contextUsage: true,
    rateLimits: true,
    mcpStatus: true,
    mcpServerActions: true,
    sessionMcpServers: true,
    slashCommands: true,
    clearContext: true,
    skillsList: false,
    settingSources: true,
    budgets: true,
    attachments: ['image', 'pdf', 'text'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    vfs: false,
    hostCwd: true,
    streaming: 'token',
  },
  codex: {
    interactiveApprovals: true,
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'auto'],
    defaultPermissionMode: 'default',
    resume: true,
    resumeBackfill: true,
    listSessions: true,
    contextUsage: true,
    rateLimits: true,
    mcpStatus: true,
    mcpServerActions: false,
    sessionMcpServers: false,
    slashCommands: false,
    clearContext: true,
    skillsList: true,
    settingSources: false,
    budgets: false,
    attachments: ['image', 'text'],
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    vfs: false,
    hostCwd: true,
    streaming: 'token',
  },
  provider: {
    interactiveApprovals: false,
    permissionModes: ['default', 'bypassPermissions', 'dontAsk'],
    defaultPermissionMode: 'default',
    resume: false,
    resumeBackfill: false,
    listSessions: false,
    contextUsage: false,
    rateLimits: false,
    mcpStatus: true,
    mcpServerActions: false,
    sessionMcpServers: false,
    slashCommands: false,
    clearContext: true,
    skillsList: false,
    settingSources: false,
    budgets: false,
    attachments: ['image', 'pdf', 'text'],
    vfs: true,
    hostCwd: false,
    streaming: 'token',
  },
}

export function supportsPermissionMode(engine: ProfileEngine | undefined, mode: PermissionMode): boolean {
  return ENGINE_CAPABILITIES[engine ?? 'claude'].permissionModes.includes(mode)
}

export type ProviderConfig = {
  id: string
  model?: string
  models?: string[]
  baseUrl?: string
  apiKeyEnv?: string
}

export type SessionCapability = 'web_search' | 'download' | 'web_fetch' | 'deliver_file'

export type ProfileSessionDefaults = {
  capabilities?: SessionCapability[]
  mcpServers?: string[]
  instructions?: string
}

export type ProfileUsageWindow = {
  info: RateLimitInfo
  updatedAt: number
  inferredReset?: boolean
}

export type ProfileUsage = Record<string, ProfileUsageWindow>

export type ProfileInfo = {
  name: string
  engine?: ProfileEngine
  configDir?: string
  codexHome?: string
  provider?: ProviderConfig
  description?: string
  defaults?: ProfileDefaults
  session?: ProfileSessionDefaults
  models?: ModelOption[]
  defaultModel?: string
  capabilities?: EngineCapabilities
  available?: boolean
  unavailableReason?: string
  usage?: ProfileUsage
  managed?: boolean
}

export type ProfileConfigSnapshot = {
  settings?: {
    model?: string
    defaultPermissionMode?: string
    permissionRules?: { allow: number; ask: number; deny: number }
    envKeys?: string[]
    hooks?: string[]
  }
  hasUserMemory: boolean
  skills: string[]
  agents: string[]
  commands: string[]
}

export type McpServerConfigWire =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

export type McpServerToolInfo = {
  name: string
  description?: string
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean }
  inputSchema?: unknown
}

export type McpServerStatusInfo = {
  name: string
  status: string
  scope?: string
  error?: string
  serverInfo?: { name: string; version: string }
  transport?: 'stdio' | 'http' | 'sse' | 'sdk'
  command?: string
  args?: string[]
  url?: string
  tools?: McpServerToolInfo[]
}

export type McpServersResponse = { servers: McpServerStatusInfo[] }

export type McpServerActionRequest = { action: 'reconnect' | 'enable' | 'disable' }

export type UploadAttachmentResponse = { attachment: MessageAttachment }

export type CreateSessionRequest = {
  cwd?: string
  profile?: string
  prompt?: string
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfigWire>
  settingSources?: Array<'user' | 'project' | 'local'>
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  resume?: string
  forkSession?: boolean
  reasoningEffort?: string
  includePartialMessages?: boolean
  approvalTimeoutMs?: number
  questionBehavior?: QuestionBehavior
  capabilities?: SessionCapability[]
  meta?: Record<string, unknown>
  scope?: Record<string, string>
}

export type SubagentInfo = {
  toolUseId: string
  agentType?: string
  description?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  toolCount: number
}

export const SUBAGENT_HISTORY = 8

export type ProjectIcon = { type: 'glyph'; name: string } | { type: 'image'; mediaType: 'image/png' | 'image/svg+xml'; hash: string }

export type ProjectInfo = {
  name: string
  root: string
  icon?: ProjectIcon
}

export type SessionInfo = {
  id: string
  sdkSessionId?: string
  status: SessionStatus
  cwd: string
  profile?: string
  engine?: ProfileEngine
  capabilities?: EngineCapabilities
  model?: string
  permissionMode?: PermissionMode
  canBypassPermissions?: boolean
  apiKeySource?: string
  createdAt: number
  lastSeq: number
  pendingPermissionCount: number
  subagents?: SubagentInfo[]
  meta?: Record<string, unknown>
  title?: string
  totalCostUsd?: number
  numTurns?: number
  activityCount?: number
  /**
   * Rows of the kind a person is actually waiting to read — see `transcriptProse`.
   * Absent from a gateway that predates it — additive, so no `PROTOCOL_VERSION` bump —
   * which is why every reader falls back to `activityCount`. This is the badge's number; `activityCount` stays the "has
   * anything happened at all" measure that sorting and dormancy read.
   */
  proseCount?: number
  lastActivityAt?: number
  contextUsage?: ContextReading
  scope?: Record<string, string>
  project?: ProjectInfo
}

export function contextReading(body: SessionEventBody): ContextReading | undefined {
  if (body.type !== 'context_usage') {
    return undefined
  }
  const { totalTokens, maxTokens, percentage } = body.usage
  return { totalTokens, maxTokens, percentage }
}

export function transcriptActivity(body: SessionEventBody): number {
  if ('parentToolUseId' in body && body.parentToolUseId != null) {
    return 0
  }
  switch (body.type) {
    case 'assistant_message': {
      const content = body.message.content
      if (typeof content === 'string') {
        return content.trim() === '' ? 0 : 1
      }
      const rows = content.filter((block) => block.type === 'text' || block.type === 'thinking' || block.type === 'tool_use').length
      return rows
    }
    case 'user_message': {
      return body.synthetic ? 0 : 1
    }
    case 'turn_result':
    case 'file_delivered':
    case 'session_error': {
      return 1
    }
    default: {
      return 0
    }
  }
}

/**
 * The unread badge's unit: output **addressed to the human**, not evidence of work.
 *
 * `transcriptActivity` counts a tool call and a paragraph alike, which is honest as
 * "how much has happened" and wrong as "how much is there to read" — a session that
 * tool-loops for a minute ticks 6, 7, 8 with nothing said yet. This scores the same
 * events through a narrower door:
 *
 * - assistant `text` blocks only — `thinking` is not addressed to anyone and `tool_use`
 *   is the noise being filtered out;
 * - the **sub-agent carve-out is inherited** (`parentToolUseId != null` scores 0): prose a
 *   sub-agent wrote to its parent is not addressed to the human either;
 * - a `turn_result` counts only when it **failed**, an interrupt or an error being a thing
 *   the human is owed; a successful turn already carried its own prose and would otherwise
 *   double-count every answer;
 * - `session_error` and `file_delivered` count — both are output, not work;
 * - `stream_delta` scores 0, exactly as in `transcriptActivity`. The badge is therefore
 *   correct within one poll of a message *completing*, never mid-stream, which is the
 *   deliberate price of leaving the streaming path alone.
 */
export function transcriptProse(body: SessionEventBody): number {
  if ('parentToolUseId' in body && body.parentToolUseId != null) {
    return 0
  }
  switch (body.type) {
    case 'assistant_message': {
      const content = body.message.content
      if (typeof content === 'string') {
        return content.trim() === '' ? 0 : 1
      }
      return content.filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '').length
    }
    case 'user_message': {
      return body.synthetic ? 0 : 1
    }
    case 'turn_result': {
      return body.isError ? 1 : 0
    }
    case 'file_delivered':
    case 'session_error': {
      return 1
    }
    default: {
      return 0
    }
  }
}

export function transcriptContent(body: SessionEventBody): boolean {
  switch (body.type) {
    case 'user_message':
    case 'assistant_message':
    case 'stream_delta':
    case 'turn_result':
    case 'execution_dispatched':
    case 'execution_result':
    case 'execution_failed':
    case 'file_delivered':
    case 'session_error':
    case 'session_closed':
    case 'conversation_reset':
    case 'context_compacted': {
      return true
    }
    default: {
      return false
    }
  }
}

export function replayCoalesceKey(body: SessionEventBody): string | undefined {
  switch (body.type) {
    case 'context_usage': {
      return 'context_usage'
    }
    case 'rate_limit': {
      return body.info.rateLimitType ? `rate_limit:${body.info.rateLimitType}` : undefined
    }
    case 'status_changed': {
      return 'status_changed'
    }
    case 'sdk_event': {
      return body.payload.type === 'system' && body.payload.subtype === 'status' ? 'sdk_event:system:status' : undefined
    }
    default: {
      return undefined
    }
  }
}

export function replayRetains(body: SessionEventBody): boolean {
  if (body.type !== 'stream_delta') {
    return true
  }
  const delta = body.event as { type?: string; delta?: { type?: string } }
  if (delta.type !== 'content_block_delta') {
    return false
  }
  return delta.delta?.type === 'text_delta' || delta.delta?.type === 'thinking_delta'
}

export function snapshotRetains(body: SessionEventBody): boolean {
  return body.type !== 'stream_delta'
}

export type SdkSessionSummary = {
  sessionId: string
  summary: string
  lastModified: number
  createdAt?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
}

export type SessionFileInfo = { path: string; bytes: number }
export type ListSessionFilesResponse = { files: SessionFileInfo[] }
export type ListSessionsResponse = { sessions: SessionInfo[] }
export type CreateSessionResponse = { session: SessionInfo }
export type GetSessionResponse = { session: SessionInfo }

export type UpdateSessionRequest = { title?: string | null }
export type UpdateSessionResponse = { session: SessionInfo }

export type ResolvePermissionRequest =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
export type ResolvePermissionResponse = { resolved: true }

export type SubmitExecutionResultRequest =
  | { status: 'ok'; output: ToolExecutionOutput; logs?: string[] }
  | { status: 'failed'; reason: string; error: string; logs?: string[] }
export type SubmitExecutionResultResponse = {
  applied: boolean
  sessionId: string
}

export type ListSdkSessionsResponse = { sdkSessions: SdkSessionSummary[] }
export type ListProfilesResponse = {
  profiles: ProfileInfo[]
  canManage?: boolean
}

export type CreateProfileRequest = ProfileInfo

export type UpdateProfileRequest = Omit<Partial<ProfileInfo>, 'name'>

export type HostFileRoot = {
  path: string
  name: string
}

export type ListHostRootsResponse = {
  roots: HostFileRoot[]
  canWrite: boolean
}

export type HostDirEntry = {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  bytes?: number
  modifiedAt?: number
}

export type ListHostDirResponse = {
  path: string
  entries: HostDirEntry[]
  truncated?: boolean
}

export type HostFileMatch = {
  path: string
  relative: string
}

export type FindHostFilesResponse = {
  base: string
  matches: HostFileMatch[]
  truncated: boolean
}

export type ReadHostFileResponse = {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
  bytes: number
  hash: string
  modifiedAt: number
}

export type WriteHostFileRequest = {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
  expectedHash?: string
}

export type WriteHostFileResponse = {
  path: string
  bytes: number
  hash: string
  modifiedAt: number
}

export type SaveProfileResponse = { profile: ProfileInfo }
export type GetProfileResponse = { profile: ProfileInfo; config: ProfileConfigSnapshot }
export type ErrorResponse = { error: string }

export type SessionNotificationType = 'permission_requested' | 'turn_completed' | 'session_error' | 'session_closed'

export type SessionNotification = {
  type: SessionNotificationType
  sessionId: string
  session: SessionInfo
  seq: number
  ts: number
  preview?: string
  request?: PermissionRequest
  result?: { isError: boolean; durationMs: number; numTurns: number; totalCostUsd: number }
  reason?: 'client' | 'server' | 'error'
}

export type SessionWebhookConfig = {
  url: string
  headers?: Record<string, string>
  events?: SessionNotificationType[]
}

export type JobStatus = 'queued' | 'running' | 'parked' | 'succeeded' | 'failed' | 'canceled'

export type WebhookConfig = {
  url: string
  headers?: Record<string, string>
  progress?: 'messages' | 'completion'
}

export type CreateJobRequest = {
  session: CreateSessionRequest & { prompt: string }
  webhook?: WebhookConfig
  maxTokens?: number
  maxDurationMs?: number
  attempts?: number
  retryDelayMs?: number
  meta?: Record<string, unknown>
}

export type JobUsage = {
  tokens: number
  totalCostUsd: number
  numTurns: number
}

export type JobResult = {
  subtype: string
  isError: boolean
  result?: string
  errors?: string[]
  durationMs: number
}

export type JobInfo = {
  id: string
  status: JobStatus
  cwd: string
  profile?: string
  prompt: string
  sessionId?: string
  sdkSessionId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  attempt?: number
  maxAttempts?: number
  nextRunAt?: number
  parkedAt?: number
  parkedExecutionId?: string
  usage: JobUsage
  result?: JobResult
  error?: string
  meta?: Record<string, unknown>
  scope?: Record<string, string>
}

export type JobProgress = {
  kind: 'assistant_text' | 'tool_use' | 'permission_requested' | 'permission_resolved'
  preview?: string
  request?: PermissionRequest
}

export type JobEvent =
  | { type: 'job_submitted'; job: JobInfo; ts: number }
  | { type: 'job_started'; job: JobInfo; ts: number }
  | { type: 'job_progress'; job: JobInfo; progress: JobProgress; ts: number }
  | { type: 'job_parked'; job: JobInfo; executionId: string; ts: number }
  | { type: 'job_resumed'; job: JobInfo; executionId: string; ts: number }
  | { type: 'job_retrying'; job: JobInfo; ts: number }
  | { type: 'job_completed'; job: JobInfo; ts: number }

export type QueueStats = {
  maxConcurrency: number
  running: number
  queued: number
  parked: number
  sessionTokenLimit?: number
  dailyTokenLimit?: number
  dailyTokensUsed: number
  paused: boolean
}

export type QueueServerFrame =
  | { type: 'queue_attached'; protocolVersion: number; stats: QueueStats }
  | { type: 'job_event'; event: JobEvent }
  | { type: 'queue_stats'; stats: QueueStats }

export type CreateJobResponse = { job: JobInfo }
export type GetJobResponse = { job: JobInfo }
export type ListJobsResponse = { jobs: JobInfo[] }
export type QueueStatsResponse = { stats: QueueStats }

export * from './session-list.ts'
export * from './usage.ts'
export * from './watermarks.ts'
