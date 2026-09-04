import { randomUUID } from 'node:crypto'
import {
  getSessionInfo,
  getSessionMessages,
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  ENGINE_CAPABILITIES,
  type CreateSessionRequest,
  type McpServerStatusInfo,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
} from '@workerdeck/protocol'
import { type AttachmentInput, attachmentContentBlocks, attachmentRef } from '../../lib/attachments.ts'
import { InputQueue } from '../../lib/input-queue.ts'
import {
  type UsageRateLimits,
  defaultModelFromSdk,
  isSyntheticUserText,
  mcpStatusInfo,
  modelOptionsFromSdk,
  normalizeSdkMessage,
  rateLimitEventsFromUsage,
  toApiMessage,
} from '../../lib/normalize.ts'
import type { PermissionDecision, Runner, SessionEventListener } from '../../runner-interface.ts'
import { EventLog } from '../../lib/event-log.ts'
import { SubscriberSet, type SubscribeOptions } from '../../lib/subscribers.ts'
import { hostTitle, sessionTitle, withTitle } from '../../lib/title.ts'
import { SubagentTracker } from './subagents.ts'

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query

export type HistoryFn = (sdkSessionId: string, options: { dir?: string }) => Promise<SessionMessage[]>

export type SessionInfoFn = (sdkSessionId: string, options: { dir?: string }) => Promise<SDKSessionInfo | undefined>

export type SessionRunnerConfig = CreateSessionRequest & {
  queryFn?: QueryFn
  env?: Record<string, string | undefined>
  pathToClaudeCodeExecutable?: string
  extraOptions?: Partial<Options>
  defaultApprovalTimeoutMs?: number
  backfillHistory?: boolean
  historyFn?: HistoryFn
  sessionInfoFn?: SessionInfoFn
}

type PendingApproval = {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

export class SessionRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: SessionRunnerConfig
  readonly #cwd: string
  #log = new EventLog()
  #subscribers = new SubscriberSet()
  #status: SessionStatus = 'starting'
  #statusDetail: string | undefined
  #sdkSessionId: string | undefined
  #model: string | undefined
  #apiKeySource: string | undefined
  #permissionMode: PermissionMode | undefined
  #pending = new Map<string, PendingApproval>()
  #turnOverWhileBlocked = false
  #subagents = new SubagentTracker()
  #totalCostUsd: number | undefined
  #numTurns: number | undefined
  #input = new InputQueue()
  #query: Query | undefined
  #capabilitiesEmitted = false
  #subscriptionType: string | undefined
  #engineTitle: string | undefined
  #started = false
  #closed = false
  #runPromise: Promise<void> | undefined

  constructor(config: SessionRunnerConfig, id: string = randomUUID()) {
    if (!config.cwd) {
      throw new Error('the claude engine requires a cwd')
    }
    this.#cwd = config.cwd
    this.#config = config
    this.#permissionMode = config.permissionMode
    this.id = id
    this.createdAt = Date.now()
  }

  get status(): SessionStatus {
    return this.#status
  }

  get sdkSessionId(): string | undefined {
    return this.#sdkSessionId
  }

  get lastSeq(): number {
    return this.#log.seq
  }

  get apiKeySource(): string | undefined {
    return this.#apiKeySource
  }

  get pendingApprovals(): PermissionRequest[] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.#cwd,
      profile: this.#config.profile,
      engine: 'claude',
      capabilities: ENGINE_CAPABILITIES.claude,
      model: this.#model ?? this.#config.model,
      permissionMode: this.#permissionMode,
      canBypassPermissions: this.#config.permissionMode === 'bypassPermissions' || this.#config.allowDangerouslySkipPermissions === true,
      apiKeySource: this.#apiKeySource,
      createdAt: this.createdAt,
      lastSeq: this.#log.seq,
      activityCount: this.#log.activityCount,
      proseCount: this.#log.proseCount,
      contextUsage: this.#log.contextUsage,
      pendingPermissionCount: this.#pending.size,
      subagents: this.#subagents.list(),
      meta: this.#config.meta,
      scope: this.#config.scope,
      title: sessionTitle(this.#config, this.#engineTitle),
      totalCostUsd: this.#totalCostUsd,
      numTurns: this.#numTurns,
      lastActivityAt: this.#log.lastActivityAt,
    }
  }

  setTitle(title: string | undefined): void {
    this.#config = withTitle(this.#config, title)
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#runPromise!
    }
    this.#started = true
    if (this.#config.prompt) {
      this.sendMessage(this.#config.prompt)
    }
    this.#runPromise = this.#run()
    return this.#runPromise
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#closed) {
      throw new Error('session is closed')
    }
    const blocks = attachments?.length ? attachmentContentBlocks(attachments) : []
    // A message may be attachments alone; an empty text block is not valid API input.
    const content = blocks.length
      ? ([...blocks, ...(text ? [{ type: 'text', text }] : [])] as unknown as SDKUserMessage['message']['content'])
      : text
    this.#input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.#sdkSessionId,
    })
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid: randomUUID(),
    })
  }

  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    const query = this.#query
    if (typeof query?.mcpServerStatus !== 'function') {
      return undefined
    }
    return (await query.mcpServerStatus()).map(mcpStatusInfo)
  }

  async reconnectMcpServer(name: string): Promise<void> {
    const query = this.#query
    if (typeof query?.reconnectMcpServer !== 'function') {
      throw new Error('this session cannot reconnect MCP servers')
    }
    await query.reconnectMcpServer(name)
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    const query = this.#query
    if (typeof query?.toggleMcpServer !== 'function') {
      throw new Error('this session cannot enable or disable MCP servers')
    }
    await query.toggleMcpServer(name, enabled)
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#pending.get(requestId)
    if (!pending) {
      return false
    }
    this.#settleApproval(requestId, pending, decision, 'client')
    return true
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt()
  }

  async clearContext(): Promise<void> {
    if (this.#status === 'closed' || this.#status === 'failed') {
      throw new Error('session is closed')
    }
    this.sendMessage('/clear')
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query?.setPermissionMode(mode)
    this.#permissionMode = mode
    this.#emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    await this.#query?.setModel(model)
    this.#model = model
    this.#emit({ type: 'model_changed', model })
  }

  fail(message: string): void {
    if (this.#closed) {
      return
    }
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    for (const [id, pending] of this.#pending) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'Session closed' }, 'policy')
    }
    this.#input.end()
    this.#query?.close()
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
  }

  eventAt(seq: number): SessionEvent | undefined {
    return this.#log.at(seq)
  }

  subscribe(listener: SessionEventListener, afterSeq = 0, options?: SubscribeOptions): () => void {
    return this.#subscribers.subscribe(this.#log.events, listener, afterSeq, options, this.#log.resetSeq)
  }

  async #run(): Promise<void> {
    const queryFn = this.#config.queryFn ?? (sdkQuery as QueryFn)
    try {
      await this.#backfillHistory()
      if (this.#closed) {
        return
      }
      this.#query = queryFn({ prompt: this.#input, options: this.#buildOptions() })
      if (!this.#config.prompt) {
        this.#setStatus('idle')
        void this.#fetchCapabilities()
        void this.#fetchContextUsage()
        void this.#fetchRateLimits()
      }
      for await (const message of this.#query) {
        this.#handleMessage(message)
      }
      if (!this.#closed) {
        this.#closed = true
        this.#input.end()
        this.#emit({ type: 'session_closed', reason: 'server' })
        this.#setStatus('closed')
      }
    } catch (error) {
      if (!this.#closed) {
        this.#emit({
          type: 'session_error',
          message: error instanceof Error ? error.message : String(error),
        })
        this.#setStatus('failed')
        this.close('error')
      }
    }
  }

  async #backfillHistory(): Promise<void> {
    const c = this.#config
    if (!c.resume || c.backfillHistory === false) {
      return
    }
    const historyFn = c.historyFn ?? ((sessionId: string, options: { dir?: string }) => getSessionMessages(sessionId, options))
    let messages: SessionMessage[]
    try {
      messages = await historyFn(c.resume, { dir: this.#cwd })
    } catch {
      return
    }
    for (const m of messages) {
      if (this.#closed) {
        return
      }
      if (m.type === 'user') {
        const message = toApiMessage(m.message)
        this.#emit({
          type: 'user_message',
          message,
          parentToolUseId: m.parent_tool_use_id,
          replay: true,
          synthetic: isSyntheticUserText(message) ? true : undefined,
          uuid: m.uuid,
        })
      } else if (m.type === 'assistant') {
        this.#emit({
          type: 'assistant_message',
          message: toApiMessage(m.message),
          parentToolUseId: m.parent_tool_use_id,
          replay: true,
          uuid: m.uuid,
        })
      }
    }
  }

  #buildOptions(): Options {
    const c = this.#config
    const options: Options = {
      cwd: this.#cwd,
      permissionMode: c.permissionMode,
      allowedTools: c.allowedTools,
      disallowedTools: c.disallowedTools,
      mcpServers: c.mcpServers as Options['mcpServers'],
      settingSources: c.settingSources,
      model: c.model,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      resume: c.resume,
      forkSession: c.forkSession,
      effort: c.reasoningEffort as Options['effort'],
      includePartialMessages: c.includePartialMessages ?? true,
      forwardSubagentText: true,
      canUseTool: this.#canUseTool,
      env: c.env,
      pathToClaudeCodeExecutable: c.pathToClaudeCodeExecutable,
      ...(c.permissionMode === 'bypassPermissions' || c.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...c.extraOptions,
    }
    return options
  }

  #handleMessage(msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.#sdkSessionId = msg.session_id
      this.#model = msg.model
      this.#permissionMode = msg.permissionMode
      this.#apiKeySource = msg.apiKeySource
      this.#emit({
        type: 'system_init',
        sdkSessionId: msg.session_id,
        model: msg.model,
        cwd: msg.cwd,
        apiKeySource: msg.apiKeySource,
        tools: msg.tools,
        skills: msg.skills,
        slashCommands: msg.slash_commands,
        permissionMode: msg.permissionMode,
        claudeCodeVersion: msg.claude_code_version,
        mcpServers: msg.mcp_servers,
      })
      this.#turnOverWhileBlocked = false
      this.#setStatus('running')
      void this.#fetchCapabilities()
      void this.#fetchToolTitles()
      void this.#fetchContextUsage()
      void this.#fetchRateLimits()
      void this.#fetchEngineTitle()
      return
    }
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      if (this.#pending.size > 0) {
        if (msg.state === 'idle') {
          this.#turnOverWhileBlocked = true
        } else if (msg.state === 'running') {
          this.#turnOverWhileBlocked = false
        }
        return
      }
      if (msg.state === 'idle') {
        this.#setStatus('idle')
      } else if (msg.state === 'running') {
        this.#setStatus('running')
      }
      return
    }
    const body = normalizeSdkMessage(msg)
    if (body) {
      this.#emit(body)
      if (body.type === 'conversation_reset') {
        if (body.sdkSessionId) {
          this.#sdkSessionId = body.sdkSessionId
        }
        void this.#fetchContextUsage()
      }
      if (body.type === 'turn_result') {
        this.#totalCostUsd = body.totalCostUsd
        this.#numTurns = body.numTurns
        if (this.#pending.size === 0) {
          this.#setStatus('idle')
        } else {
          this.#turnOverWhileBlocked = true
        }
        void this.#fetchContextUsage()
        void this.#fetchRateLimits()
        void this.#fetchEngineTitle()
      }
    }
  }

  // Best-effort: the SDK's status type stops short of the MCP title, so a server that sets one
  // is reported only when the CLI happens to forward it.
  async #fetchToolTitles(): Promise<void> {
    const servers = await this.mcpServers().catch(() => undefined)
    if (this.#closed || !servers) {
      return
    }
    const titles: Record<string, string> = {}
    for (const server of servers) {
      for (const tool of server.tools ?? []) {
        if (tool.title) {
          titles[`mcp__${server.name}__${tool.name}`] = tool.title
        }
      }
    }
    if (Object.keys(titles).length > 0) {
      this.#emit({ type: 'tool_titles', titles })
    }
  }

  async #fetchCapabilities(): Promise<void> {
    if (this.#capabilitiesEmitted) {
      return
    }
    const query = this.#query
    if (typeof query?.supportedModels !== 'function' || typeof query.supportedCommands !== 'function') {
      return
    }
    try {
      const [models, commands] = await Promise.all([query.supportedModels(), query.supportedCommands()])
      if (this.#closed || this.#capabilitiesEmitted) {
        return
      }
      this.#capabilitiesEmitted = true
      this.#emit({
        type: 'capabilities',
        models: modelOptionsFromSdk(models),
        defaultModel: defaultModelFromSdk(models),
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        })),
      })
    } catch {}
  }

  async #fetchEngineTitle(): Promise<void> {
    if (hostTitle(this.#config.meta)) {
      return
    }
    const sdkSessionId = this.#sdkSessionId
    if (!sdkSessionId) {
      return
    }
    const read = this.#config.sessionInfoFn ?? getSessionInfo
    try {
      const info = await read(sdkSessionId, { dir: this.#cwd })
      if (this.#closed || !info) {
        return
      }
      const summary = info.summary && info.summary !== info.firstPrompt ? info.summary : undefined
      const title = info.customTitle || summary
      if (title) {
        this.#engineTitle = title
      }
    } catch {}
  }

  async #fetchContextUsage(): Promise<void> {
    const query = this.#query
    if (typeof query?.getContextUsage !== 'function') {
      return
    }
    try {
      const usage = await query.getContextUsage()
      if (this.#closed) {
        return
      }
      this.#emit({
        type: 'context_usage',
        usage: {
          categories: usage.categories.map((c) => ({
            name: c.name,
            tokens: c.tokens,
            color: c.color,
          })),
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
        },
      })
    } catch {}
  }

  async #fetchRateLimits(): Promise<void> {
    const query = this.#query as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> } | undefined
    const fetchUsage = query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof fetchUsage !== 'function') {
      return
    }
    try {
      const usage = (await fetchUsage.call(query)) as UsageRateLimits
      if (this.#closed) {
        return
      }
      const subscriptionType = usage.subscription_type
      if (subscriptionType && subscriptionType !== this.#subscriptionType) {
        this.#subscriptionType = subscriptionType
        this.#emit({ type: 'plan_info', subscriptionType })
      }
      for (const body of rateLimitEventsFromUsage(usage)) {
        this.#emit(body)
      }
    } catch {}
  }

  #canUseTool: CanUseTool = (toolName, input, options) => {
    const id = randomUUID()
    const timeoutMs = this.#config.approvalTimeoutMs ?? this.#config.defaultApprovalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    const request: PermissionRequest = {
      id,
      toolName,
      input,
      toolUseId: options.toolUseID,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      decisionReason: options.decisionReason,
      agentId: options.agentID,
      expiresAt: Date.now() + timeoutMs,
    }
    const questionBehavior = this.#config.questionBehavior ?? 'ask'
    if (toolName === 'AskUserQuestion' && questionBehavior !== 'ask') {
      delete request.expiresAt
      return Promise.resolve(this.#resolveQuestionByPolicy(request, questionBehavior))
    }
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#settleApproval(id, pending, { behavior: 'deny', message: 'Approval timed out' }, 'timeout')
        }
      }, timeoutMs)
      this.#pending.set(id, { request, resolve, timer })
      options.signal.addEventListener('abort', () => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#settleApproval(id, pending, { behavior: 'deny', message: 'Turn aborted' }, 'policy')
        }
      })
      this.#emit({ type: 'permission_requested', request })
      this.#setStatus('awaiting_approval')
    })
  }

  #resolveQuestionByPolicy(request: PermissionRequest, mode: 'auto' | 'deny'): PermissionResult {
    this.#emit({ type: 'permission_requested', request })
    if (mode === 'deny') {
      const message = 'Interactive questions are disabled for this session — choose the most reasonable option yourself and continue.'
      this.#emit({
        type: 'permission_resolved',
        requestId: request.id,
        behavior: 'deny',
        resolvedBy: 'policy',
        message,
      })
      return { behavior: 'deny', message, toolUseID: request.toolUseId }
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: request.id,
      behavior: 'allow',
      resolvedBy: 'policy',
    })
    return {
      behavior: 'allow',
      updatedInput: { ...request.input, answers: recommendedAnswers(request.input) },
      toolUseID: request.toolUseId,
    }
  }

  #settleApproval(id: string, pending: PendingApproval, decision: PermissionDecision, resolvedBy: 'client' | 'timeout' | 'policy'): void {
    clearTimeout(pending.timer)
    this.#pending.delete(id)
    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? pending.request.input,
        toolUseID: pending.request.toolUseId,
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: decision.message ?? 'Denied',
        interrupt: decision.interrupt,
        toolUseID: pending.request.toolUseId,
      })
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: id,
      behavior: decision.behavior,
      resolvedBy,
      message: decision.behavior === 'deny' ? (decision.message ?? 'Denied') : undefined,
    })
    if (this.#pending.size === 0) {
      const endedWhileBlocked = this.#turnOverWhileBlocked
      this.#turnOverWhileBlocked = false
      if (endedWhileBlocked) {
        this.#setStatus('idle')
      } else if (this.#status === 'awaiting_approval') {
        this.#setStatus('running')
      }
    }
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#status === status && this.#statusDetail === detail) {
      return
    }
    if (this.#status === 'closed' || this.#status === 'failed') {
      return
    }
    this.#status = status
    this.#statusDetail = detail
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    const event = this.#log.append(body)
    this.#subagents.observe(body, event.ts)
    this.#subscribers.emit(event)
  }
}

function recommendedAnswers(input: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  for (const entry of questions) {
    const q = entry as { question?: unknown; options?: unknown }
    if (typeof q.question !== 'string' || !Array.isArray(q.options)) {
      continue
    }
    const first = q.options[0] as { label?: unknown } | undefined
    if (typeof first?.label === 'string') {
      answers[q.question] = first.label
    }
  }
  return answers
}
