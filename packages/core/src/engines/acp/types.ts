export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type AcpToolCall = {
  toolCallId: string
  name?: string
  title?: string
  kind?: string
  status?: AcpToolCallStatus
  rawInput?: unknown
  rawOutput?: unknown
  content?: AcpToolCallContent[]
  locations?: Array<{ path: string; line?: number }>
}

export type AcpPlanEntry = { content: string; priority?: string; status: 'pending' | 'in_progress' | 'completed' }

export type AcpConfigOption = {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: string
  options?: Array<{ value: string; name?: string; description?: string }>
}

export type AcpCommand = { name: string; description?: string; input?: { hint?: string } | null }

export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCall)
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AcpCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'config_option_update'; configOptions: AcpConfigOption[] }
  | { sessionUpdate: 'session_info_update'; title?: string | null }
  | { sessionUpdate: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } | null }

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type AcpUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

export type AcpPromptResponse = { stopReason?: AcpStopReason; usage?: AcpUsage }

export type AcpSessionResponse = { sessionId?: string; configOptions?: AcpConfigOption[] }

export type AcpPermissionOption = { optionId: string; name?: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }

export type AcpPermissionRequest = { sessionId: string; toolCall: AcpToolCall; options: AcpPermissionOption[] }

export type AcpPermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }

export type AcpInitializeResponse = {
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: Record<string, unknown>
  authMethods?: Array<{ id: string; name?: string }>
}

export type AcpConnection = {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(handler: (method: string, params: unknown, id: string | number) => Promise<unknown>): void
  onClose(handler: (message: string) => void): void
  close(): void
}

export type AcpConnectFn = (options: { env: Record<string, string>; cwd: string }) => AcpConnection
