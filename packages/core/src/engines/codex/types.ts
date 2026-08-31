export type AppServerTokenUsage = {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens?: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type AppServerRateLimitWindow = {
  usedPercent?: number | null
  windowDurationMins?: number | null
  resetsAt?: number | null
}

export type AppServerRateLimits = {
  primary?: AppServerRateLimitWindow | null
  secondary?: AppServerRateLimitWindow | null
  planType?: string | null
  rateLimitReachedType?: string | null
}

export type AppServerTokenUsageUpdate = {
  threadId: string
  turnId: string
  tokenUsage: { last: AppServerTokenUsage; total: AppServerTokenUsage; modelContextWindow?: number | null }
}

export type AppServerAgentMessageItem = { id: string; type: 'agentMessage'; text: string }
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
  status: string
}
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
export type AppServerImageGenerationItem = {
  id: string
  type: 'imageGeneration'
  status: string
  revisedPrompt?: string | null
  result: string
  savedPath?: string
}
export type AppServerImageViewItem = { id: string; type: 'imageView'; path: string }
export type AppServerSubAgentActivityItem = {
  id: string
  type: 'subAgentActivity'
  kind: string
  agentThreadId: string
  agentPath?: string | null
}
export type AppServerCollabAgentToolCallItem = {
  id: string
  type: 'collabAgentToolCall'
  tool: string
  status: string
  senderThreadId?: string | null
  receiverThreadIds?: string[] | null
  prompt?: string | null
  model?: string | null
  reasoningEffort?: string | null
  agentsStates?: Record<string, unknown> | null
}
export type AppServerUserMessageItem = { id: string; type: 'userMessage'; content?: unknown }
// Deliberately not a union member: an index signature would defeat discriminant narrowing.
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
  | AppServerSubAgentActivityItem
  | AppServerCollabAgentToolCallItem

export type AppServerTurn = {
  id: string
  status: string
  error?: { message: string } | null
  items?: AppServerItem[]
}

export type AppServerHistoryTurn = {
  id: string
  items?: AppServerItem[]
  itemsView?: string
  status?: string
}

export type AppServerThreadSummary = {
  id: string
  name?: string | null
  preview?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  cwd?: string | null
  ephemeral?: boolean
  gitInfo?: { branch?: string | null } | null
}

export type AppServerThreadListResponse = {
  data?: AppServerThreadSummary[]
  nextCursor?: string | null
}

export type AppServerSkillMetadata = {
  name: string
  description?: string
  shortDescription?: string
  interface?: {
    displayName?: string
    shortDescription?: string
    defaultPrompt?: string
  }
  path?: string
  scope?: string
  enabled?: boolean
}

export type AppServerSkillsListResponse = {
  data?: Array<{
    cwd?: string
    skills?: AppServerSkillMetadata[]
    errors?: Array<{ path?: string; message?: string }>
  }>
}

export type AppServerMcpServerStatus = {
  name: string
  serverInfo?: { name?: string; version?: string; title?: string | null } | null
  tools?: Record<string, AppServerMcpTool | undefined>
  authStatus?: string
}

export type AppServerMcpTool = {
  name?: string
  title?: string | null
  description?: string | null
  inputSchema?: unknown
  annotations?: {
    readOnlyHint?: boolean | null
    destructiveHint?: boolean | null
    openWorldHint?: boolean | null
  } | null
}

export type AppServerMcpServerStatusResponse = {
  data?: AppServerMcpServerStatus[]
  nextCursor?: string | null
}

export type AppServerMcpStatusUpdate = {
  threadId?: string | null
  name: string
  status?: string
  error?: string | null
  failureReason?: string | null
}

export type AppServerUserInput = { type: 'text'; text: string } | { type: 'localImage'; path: string }

export type AppServerPlanUpdate = {
  threadId: string
  turnId: string
  plan: Array<{ step: string; status: string }>
}

export type AppServerCommandApprovalParams = {
  threadId: string
  turnId?: string
  itemId: string
  approvalId?: string | null
  command?: string | null
  cwd?: string | null
  reason?: string | null
  availableDecisions?: unknown[]
}

export type AppServerFileChangeApprovalParams = {
  threadId: string
  turnId?: string
  itemId: string
  grantRoot?: string | null
  reason?: string | null
  availableDecisions?: unknown[]
}

export type AppServerPermissionsApprovalParams = {
  threadId: string
  turnId?: string
  itemId: string
  cwd?: string | null
  reason?: string | null
  permissions?: Record<string, unknown> | null
}

export type AppServerUserInputQuestion = {
  id: string
  header?: string
  question: string
  isOther?: boolean
  isSecret?: boolean
  options?: Array<{ label: string; description?: string }> | null
}

export type AppServerUserInputParams = {
  threadId: string
  turnId?: string
  itemId: string
  questions: AppServerUserInputQuestion[]
  autoResolutionMs?: number | null
}

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

export type AppServerConnection = {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(handler: (method: string, params: unknown, id: string | number) => Promise<unknown>): void
  // Fires once when the child exits or the pipe breaks — never on close().
  onClose(handler: (message: string) => void): void
  close(): void
}

export type AppServerConnectOptions = {
  env: Record<string, string>
}

export type AppServerConnectFn = (options: AppServerConnectOptions) => AppServerConnection
