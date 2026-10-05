import { randomUUID } from 'node:crypto'
import {
  createSdkMcpServer,
  getSessionInfo,
  getSessionMessages,
  query as sdkQuery,
  tool as sdkTool,
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
  errorMessage,
  type ContextUsage,
  type McpServerStatusInfo,
  type ModelOption,
  type PermissionMode,
  type PermissionRequest,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
} from '@workerdeck/protocol'
import { type AttachmentInput, attachmentContentBlocks } from '../../lib/attachments.ts'
import { withoutGatewaySecrets } from '../../lib/child-env.ts'
import { TaskChecklist, checklistFromBody, sameChecklist } from '../../lib/checklist.ts'
import { InputQueue } from '../../lib/input-queue.ts'
import { ToolOutputTails } from '../../lib/tool-output.ts'
import { isSlashCommand } from '../../lib/local-command.ts'
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
import type {
  ClearContextOptions,
  EngineRunnerConfig,
  PermissionDecision,
  Runner,
  SendMessageOptions,
  SleepResult,
} from '../../runner-interface.ts'
import { EngineRunner, type SessionReportFacts } from '../../lib/engine-runner.ts'
import { QUESTIONS_DISABLED_MESSAGE, approvalResolution, type CloseReason, type RunnerCoreHooks } from '../../lib/runner-core.ts'
import { hostTitle } from '../../lib/title.ts'
import { resolveInstructions } from '../../lib/instructions.ts'
import { PEER_MCP_SERVER, withPeerContext, withoutPeerContextMessage } from '../../lib/peers.ts'
import { liveContextFromReading, withDeadline, type LiveContext } from '../../lib/session-report.ts'
import { assertEffort, effortDefaultFor } from '../../lib/effort.ts'
import { sessionTools } from '../../lib/session-tools.ts'
import { agentResetFields } from '../../lib/context-reset.ts'
import { shellToolNeedsCard, shellToolOf, shellWriteToolOf } from '../../lib/shells.ts'
import { CLAUDE_CATALOG } from './catalog.ts'
import { SubagentTracker } from './subagents.ts'
import { tailTaskOutput, taskOutputRoots } from './task-output.ts'

// An attach is a client arriving to look at the number, not a reason to ask the CLI a second time within the minute.
const USAGE_REFRESH_MIN_MS = 60_000
const REPORT_PROBE_TIMEOUT_MS = 5_000

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query

export type HistoryFn = (sdkSessionId: string, options: { dir?: string }) => Promise<SessionMessage[]>

export type SessionInfoFn = (sdkSessionId: string, options: { dir?: string }) => Promise<SDKSessionInfo | undefined>

type EffortLevel = NonNullable<Options['effort']>

type SettingsQuery = Query & { getSettings?: () => Promise<{ applied?: { model?: string; effort?: string | null } }> }

export type SessionRunnerConfig = EngineRunnerConfig & {
  queryFn?: QueryFn
  pathToClaudeCodeExecutable?: string
  extraOptions?: Partial<Options>
  backfillHistory?: boolean
  historyFn?: HistoryFn
  sessionInfoFn?: SessionInfoFn
}

export class SessionRunner extends EngineRunner<SessionRunnerConfig> implements Runner {
  readonly #cwd: string
  readonly #instructions: string | undefined
  #tasks = new TaskChecklist()
  #sdkSessionId: string | undefined
  #model: string | undefined
  #apiKeySource: string | undefined
  #permissionMode: PermissionMode | undefined
  #effortRequest: string | undefined
  #effortExplicit: boolean
  #effort: string | null | undefined
  #turnOverWhileBlocked = false
  #subagents = new SubagentTracker()
  #outputTails = new ToolOutputTails((body) => this.core.emit(body))
  #numTurns: number | undefined
  #input = new InputQueue()
  // The row a compaction is drawing on, from the first 'compacting' status to the boundary that
  // settles it. The boundary has a uuid of its own, but it is the *end* of the compaction, so
  // correlating here is what lets one row settle rather than two rows appear.
  #compactionId: string | undefined
  #compactionTurns = 0
  #agentResetReason: string | undefined
  #idleWhileCompacting = false
  #query: Query | undefined
  #asleep = false
  #capabilitiesEmitted = false
  #models: ModelOption[] | undefined
  #defaultModel: string | undefined
  #subscriptionType: string | undefined
  #engineTitle: string | undefined
  #lastRateLimitPoll = 0
  #started = false
  #runPromise: Promise<void> | undefined

  constructor(config: SessionRunnerConfig, id: string = randomUUID()) {
    super(config, id, Date.now(), { cost: 'reconcile' })
    if (!config.cwd) {
      throw new Error('the claude engine requires a cwd')
    }
    this.#cwd = config.cwd
    this.#permissionMode = config.permissionMode
    this.#effortExplicit = config.reasoningEffort !== undefined
    this.#effortRequest = config.reasoningEffort ?? effortDefaultFor(config.effortDefaults, CLAUDE_CATALOG.models, config.model)
    // A fork mints its own id at the first turn; a plain resume continues the conversation it names.
    this.#sdkSessionId = config.forkSession ? undefined : config.resume
    this.#instructions = resolveInstructions(config.instructions, { sessionId: id, cwd: config.cwd, profile: config.profile })
    if (this.#instructions !== undefined && config.extraOptions?.systemPrompt !== undefined) {
      throw new Error('instructions and extraOptions.systemPrompt both set - the host must pick one')
    }
  }

  protected override coreHooks(): RunnerCoreHooks {
    return {
      observe: (body, event) => {
        this.#subagents.observe(body, event.ts)
        this.#outputTails.observe(body)
      },
      settled: (body) => this.#followChecklist(body),
      holdStatus: (status) => this.#holdIdleWhileCompacting(status),
    }
  }

  get sdkSessionId(): string | undefined {
    return this.#sdkSessionId
  }

  get apiKeySource(): string | undefined {
    return this.#apiKeySource
  }

  info(): SessionInfo {
    return {
      ...this.baseInfo(this.#engineTitle),
      sdkSessionId: this.#sdkSessionId,
      cwd: this.#cwd,
      engine: 'claude',
      capabilities: ENGINE_CAPABILITIES.claude,
      model: this.#model ?? this.config.model,
      ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
      permissionMode: this.#permissionMode,
      canBypassPermissions: this.config.permissionMode === 'bypassPermissions' || this.config.allowDangerouslySkipPermissions === true,
      apiKeySource: this.#apiKeySource,
      subagents: this.#subagents.list(),
      totalCostUsd: this.core.cost.reportedCostUsd,
      numTurns: this.#numTurns,
      ...(this.#asleep ? { engineAsleep: true as const } : {}),
    }
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#runPromise!
    }
    this.#started = true
    if (this.config.prompt) {
      this.sendMessage(this.config.prompt)
    }
    this.#runPromise = this.#run()
    return this.#runPromise
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    this.assertAccepting()
    const blocks = attachments?.length ? attachmentContentBlocks(attachments) : []
    // A slash command is matched on the message text by the CLI, so held output waits for the next plain message.
    const context = isSlashCommand(text) ? undefined : this.localCommands.take()
    if (context) {
      blocks.unshift({ type: 'text', text: context })
    }
    const modelText = withPeerContext(text, options)
    // A message may be attachments alone; an empty text block is not valid API input.
    const content = blocks.length
      ? ([...blocks, ...(modelText ? [{ type: 'text', text: modelText }] : [])] as unknown as SDKUserMessage['message']['content'])
      : modelText
    this.#input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.#sdkSessionId,
    })
    if (this.#asleep) {
      this.#wake()
    }
    this.echoUser(text, attachments, options)
  }

  async sleep(): Promise<SleepResult> {
    const refused = this.#sleepRefusal()
    if (refused) {
      return { ok: false, reason: refused }
    }
    if (this.#asleep) {
      return { ok: true }
    }
    const query = this.#query
    const input = this.#input
    this.#asleep = true
    this.#query = undefined
    this.#input = new InputQueue()
    input.end()
    query?.close()
    this.#outputTails.clear()
    this.core.cost.restartProcess()
    this.core.emit({ type: 'engine_sleep', asleep: true })
    return { ok: true }
  }

  #sleepRefusal(): string | undefined {
    if (this.core.closed) {
      return 'session is closed'
    }
    if (this.#asleep) {
      return undefined
    }
    if (this.core.status !== 'idle') {
      return `session is ${this.core.status}`
    }
    if (this.core.pendingCount > 0) {
      return 'a permission request is pending'
    }
    if (this.#compactionId !== undefined) {
      return 'the context is being compacted'
    }
    if (this.#subagents.list()?.some((sub) => sub.status === 'running')) {
      return 'a subagent or background task is still running'
    }
    if (this.#input.pending > 0) {
      return 'a message is waiting for the engine'
    }
    if (!this.#query || !this.#sdkSessionId) {
      return 'the engine has not started a conversation yet'
    }
    return undefined
  }

  #wake(): void {
    this.#asleep = false
    this.core.emit({ type: 'engine_sleep', asleep: false })
    this.core.setStatus('starting')
    void this.#runAwake()
  }

  async #runAwake(): Promise<void> {
    try {
      const query = this.#openQuery({
        resume: this.#sdkSessionId,
        forkSession: false,
        model: this.#model,
        permissionMode: this.#permissionMode,
      })
      void this.#syncEffort()
      await this.#pump(query)
    } catch (error) {
      this.fail(errorMessage(error))
    }
  }

  get engineAsleep(): boolean {
    return this.#asleep
  }

  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    const query = this.#query
    if (typeof query?.mcpServerStatus !== 'function') {
      return undefined
    }
    return (await query.mcpServerStatus()).map(mcpStatusInfo)
  }

  async reconnectMcpServer(name: string): Promise<void> {
    const query = this.#awakeQuery()
    if (typeof query?.reconnectMcpServer !== 'function') {
      throw new Error('this session cannot reconnect MCP servers')
    }
    await query.reconnectMcpServer(name)
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    const query = this.#awakeQuery()
    if (typeof query?.toggleMcpServer !== 'function') {
      throw new Error('this session cannot enable or disable MCP servers')
    }
    await query.toggleMcpServer(name, enabled)
  }

  #awakeQuery(): Query | undefined {
    if (this.#asleep) {
      throw new Error('the session is asleep: its MCP servers start again with the next message')
    }
    return this.#query
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt()
  }

  async stopTask(toolUseId: string): Promise<boolean> {
    const taskId = this.#subagents.taskIdOf(toolUseId)
    if (taskId === undefined || !this.#query) {
      return false
    }
    await this.#query.stopTask(taskId)
    return true
  }

  async backgroundTask(toolUseId?: string): Promise<boolean> {
    if (!this.#query) {
      return false
    }
    return await this.#query.backgroundTasks(toolUseId)
  }

  async clearContext(options?: ClearContextOptions): Promise<void> {
    if (this.core.terminal) {
      throw new Error('session is closed')
    }
    this.localCommands.clear()
    this.#agentResetReason = options?.agentReason
    this.sendMessage('/clear')
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query?.setPermissionMode(mode)
    this.#permissionMode = mode
    this.core.emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    await this.#query?.setModel(model)
    this.#model = model
    this.core.emit({ type: 'model_changed', model })
    const fallback = effortDefaultFor(this.config.effortDefaults, this.#catalog(), model)
    if (fallback !== undefined) {
      this.#effortExplicit = false
      await this.#requestEffort(fallback)
    } else if (!this.#effortExplicit && this.#effortRequest !== undefined) {
      await this.#requestEffort(undefined)
    } else {
      await this.#syncEffort()
    }
  }

  async setEffort(effort?: string): Promise<void> {
    assertEffort(effort, ENGINE_CAPABILITIES.claude.reasoningEfforts)
    this.#effortExplicit = effort !== undefined
    await this.#requestEffort(effort ?? effortDefaultFor(this.config.effortDefaults, this.#catalog(), this.#model))
  }

  async #requestEffort(effort: string | undefined): Promise<void> {
    this.#effortRequest = effort
    const query = this.#query
    if (!query) {
      if (effort !== undefined) {
        this.#reportEffort(effort)
      }
      return
    }
    await query.applyFlagSettings({ effortLevel: (effort ?? null) as EffortLevel | null })
    await this.#syncEffort()
  }

  async #syncEffort(): Promise<void> {
    const query = this.#query as SettingsQuery | undefined
    if (typeof query?.getSettings !== 'function') {
      return
    }
    try {
      let applied = (await query.getSettings()).applied
      if (!this.#effortExplicit && this.#effortRequest === undefined) {
        const fallback = effortDefaultFor(this.config.effortDefaults, this.#catalog(), this.#model, applied?.model)
        if (fallback !== undefined) {
          this.#effortRequest = fallback
          await query.applyFlagSettings({ effortLevel: fallback as EffortLevel })
          applied = (await query.getSettings()).applied
        }
      }
      if (this.core.closed || query !== this.#query || !applied || !('effort' in applied)) {
        return
      }
      this.#reportEffort(applied.effort ?? null)
    } catch {}
  }

  #reportEffort(effort: string | null): void {
    if (effort === this.#effort) {
      return
    }
    this.#effort = effort
    this.core.emit({ type: 'effort_changed', effort })
  }

  #catalog(): readonly ModelOption[] {
    return this.#models ?? CLAUDE_CATALOG.models
  }

  close(reason: CloseReason = 'client'): void {
    this.core.close(reason, () => {
      this.localCommands.clear()
      this.#outputTails.clear()
      this.#input.end()
      this.#query?.close()
    })
  }

  async #run(): Promise<void> {
    try {
      await this.#backfillHistory()
      if (this.core.closed) {
        return
      }
      if (this.config.resume && !this.config.prompt) {
        void this.#fetchEngineTitle()
      }
      if (this.#startsAsleep()) {
        this.#asleep = true
        this.core.emit({ type: 'engine_sleep', asleep: true })
        this.core.setStatus('idle')
        return
      }
      const query = this.#openQuery()
      void this.#syncEffort()
      if (!this.config.prompt) {
        this.core.setStatus('idle')
        void this.#fetchCapabilities()
        void this.#fetchContextUsage()
        void this.#fetchRateLimits()
      }
      await this.#pump(query)
    } catch (error) {
      this.fail(errorMessage(error))
    }
  }

  #startsAsleep(): boolean {
    return this.config.startAsleep === true && !this.config.prompt && this.#sdkSessionId !== undefined && this.#input.pending === 0
  }

  #openQuery(overrides: Partial<Options> = {}): Query {
    const queryFn = this.config.queryFn ?? (sdkQuery as QueryFn)
    const query = queryFn({ prompt: this.#input, options: { ...this.#buildOptions(), ...overrides } })
    this.#query = query
    return query
  }

  // A query that is no longer `#query` was put to sleep: its end, and anything it throws on the way out, is not the session's.
  async #pump(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (query !== this.#query) {
          return
        }
        this.#handleMessage(message)
      }
    } catch (error) {
      if (query !== this.#query) {
        return
      }
      throw error
    }
    if (query !== this.#query) {
      return
    }
    this.core.close('server', () => this.#input.end(), { settleApprovals: false })
  }

  async #backfillHistory(): Promise<void> {
    const c = this.config
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
      if (this.core.closed) {
        return
      }
      if (m.type === 'user') {
        const raw = toApiMessage(m.message)
        const { message, origin } = m.parent_tool_use_id == null ? withoutPeerContextMessage(raw) : { message: raw }
        this.core.emit({
          type: 'user_message',
          message,
          parentToolUseId: m.parent_tool_use_id,
          replay: true,
          synthetic: isSyntheticUserText(message) ? true : undefined,
          ...(origin ? { origin } : {}),
          uuid: m.uuid,
        })
      } else if (m.type === 'assistant') {
        this.core.emit({
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
    const c = this.config
    const options: Options = {
      cwd: this.#cwd,
      permissionMode: c.permissionMode,
      allowedTools: c.allowedTools,
      disallowedTools: c.disallowedTools,
      mcpServers: this.#mcpServersOption(),
      settingSources: c.settingSources,
      model: c.model,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      resume: c.resume,
      forkSession: c.forkSession,
      effort: this.#effortRequest as EffortLevel | undefined,
      includePartialMessages: c.includePartialMessages ?? true,
      forwardSubagentText: true,
      canUseTool: this.#canUseTool,
      env: withoutGatewaySecrets(c.env ?? process.env),
      pathToClaudeCodeExecutable: c.pathToClaudeCodeExecutable,
      ...(c.permissionMode === 'bypassPermissions' || c.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...c.extraOptions,
      ...(this.#instructions === undefined
        ? {}
        : { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: this.#instructions } }),
    }
    return options
  }

  #mcpServersOption(): Options['mcpServers'] {
    const declared = this.config.mcpServers as Options['mcpServers']
    const tools = sessionTools(this.toolSources, () => this.id).map((gatewayTool) =>
      sdkTool(gatewayTool.name, gatewayTool.description, gatewayTool.shape, async (args) => {
        const output = await gatewayTool.run(args)
        return { content: [{ type: 'text', text: output.text }], isError: output.isError }
      }),
    )
    return { ...declared, [PEER_MCP_SERVER]: createSdkMcpServer({ name: PEER_MCP_SERVER, tools }) }
  }

  #tailForegroundBash(msg: { task_id: string; tool_use_id?: string; task_type?: string; is_backgrounded?: boolean }): void {
    const sessionId = this.#sdkSessionId
    if (msg.task_type !== 'local_bash' || msg.is_backgrounded !== false || !msg.tool_use_id || !sessionId) {
      return
    }
    if (this.#outputTails.has(msg.tool_use_id)) {
      return
    }
    tailTaskOutput(this.#outputTails, {
      toolUseId: msg.tool_use_id,
      taskId: msg.task_id,
      sessionId,
      roots: taskOutputRoots(this.config.env ?? process.env),
    })
  }

  #handleMessage(msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.#sdkSessionId = msg.session_id
      this.#model = msg.model
      this.#permissionMode = msg.permissionMode
      this.#apiKeySource = msg.apiKeySource
      this.core.emit({
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
      this.core.setStatus('running')
      void this.#fetchCapabilities()
      void this.#fetchToolTitles()
      void this.#fetchContextUsage()
      void this.#fetchRateLimits()
      void this.#fetchEngineTitle()
      void this.#syncEffort()
      return
    }
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      if (this.core.pendingCount > 0) {
        if (msg.state === 'idle') {
          this.#turnOverWhileBlocked = true
        } else if (msg.state === 'running') {
          this.#turnOverWhileBlocked = false
        }
        return
      }
      if (msg.state === 'idle') {
        this.core.setStatus('idle')
      } else if (msg.state === 'running') {
        this.core.setStatus('running')
      }
      return
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') {
      // Ignored before the first fetch resolves: supportedCommands() tracks the latest push, so the
      // fetch already returns this list, and re-emitting here would ship an empty model list.
      if (this.#capabilitiesEmitted && !this.core.closed) {
        this.#emitCapabilities(msg.commands)
      }
      return
    }
    if (msg.type === 'system' && msg.subtype === 'status') {
      this.#handleCompactionStatus(msg)
    }
    if (msg.type === 'system' && msg.subtype === 'task_started') {
      this.#tailForegroundBash(msg)
    }
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata
      this.#settleCompaction({ trigger: meta.trigger, preTokens: meta.pre_tokens, postTokens: meta.post_tokens }, msg.uuid)
      void this.#fetchContextUsage()
      return
    }
    const normalized = normalizeSdkMessage(msg)
    const body = normalized?.type === 'conversation_reset' ? { ...normalized, ...this.#takeAgentReset() } : normalized
    if (body) {
      this.core.emit(body)
      if (body.type === 'conversation_reset') {
        this.core.cost.rollover()
        this.localCommands.clear()
        if (body.sdkSessionId) {
          this.#sdkSessionId = body.sdkSessionId
        }
        void this.#fetchContextUsage()
      }
      if (body.type === 'turn_result') {
        // A manual `/compact` ends its own local-command turn straight away and summarises for
        // a minute afterwards, so the first result is no evidence at all. Only a second turn
        // ending with the boundary still missing means the compaction is really lost.
        this.#compactionTurns += 1
        if (this.#compactionTurns > 1) {
          this.#settleCompaction()
        }
        this.core.cost.observeCumulative(body.usageByModel, body.totalCostUsd)
        body.totalCostUsd = this.core.cost.reportedCostUsd ?? body.totalCostUsd
        body.usageByModel = this.core.cost.byModel
        body.costUsd = this.core.cost.costUsd
        this.#numTurns = body.numTurns
        if (this.core.pendingCount === 0) {
          this.core.setStatus('idle')
        } else {
          this.#turnOverWhileBlocked = true
        }
        void this.#fetchContextUsage()
        void this.#fetchRateLimits()
        void this.#fetchEngineTitle()
      }
    }
  }

  #takeAgentReset(): { agentReason?: string } {
    const reason = this.#agentResetReason
    this.#agentResetReason = undefined
    return agentResetFields({ agentReason: reason })
  }

  #handleCompactionStatus(msg: { status?: string | null; compact_result?: 'success' | 'failed'; compact_error?: string }): void {
    if (msg.status === 'compacting') {
      this.#compactionId ??= randomUUID()
      this.#compactionTurns = 0
      this.core.emit({ type: 'context_compacted', uuid: this.#compactionId, pending: true })
      this.core.setStatus('running')
      return
    }
    if (msg.compact_result === 'failed') {
      this.#settleCompaction({ error: msg.compact_error ?? 'the engine reported no reason' })
    }
  }

  #settleCompaction(
    settled: { trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number; error?: string } = {},
    boundaryUuid?: string,
  ): void {
    const uuid = this.#compactionId ?? boundaryUuid
    if (uuid === undefined) {
      return
    }
    this.#compactionId = undefined
    this.core.emit({ type: 'context_compacted', uuid, ...settled })
    if (this.#idleWhileCompacting && this.core.pendingCount === 0) {
      this.core.setStatus('idle')
    }
    this.#idleWhileCompacting = false
  }

  // Best-effort: the SDK's status type stops short of the MCP title, so a server that sets one
  // is reported only when the CLI happens to forward it.
  async #fetchToolTitles(): Promise<void> {
    const servers = await this.mcpServers().catch(() => undefined)
    if (this.core.closed || !servers) {
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
      this.core.emit({ type: 'tool_titles', titles })
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
      if (this.core.closed || this.#capabilitiesEmitted) {
        return
      }
      this.#capabilitiesEmitted = true
      this.#models = modelOptionsFromSdk(models)
      this.#defaultModel = defaultModelFromSdk(models)
      this.#emitCapabilities(commands)
    } catch {}
  }

  #emitCapabilities(commands: readonly { name: string; description?: string; argumentHint?: string; aliases?: string[] }[]): void {
    this.core.emit({
      type: 'capabilities',
      models: this.#models ?? [],
      defaultModel: this.#defaultModel,
      commands: commands.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        aliases: c.aliases,
      })),
    })
  }

  async #fetchEngineTitle(): Promise<void> {
    if (hostTitle(this.config.meta)) {
      return
    }
    const sdkSessionId = this.#sdkSessionId ?? this.config.resume
    if (!sdkSessionId) {
      return
    }
    const read = this.config.sessionInfoFn ?? getSessionInfo
    try {
      const info = await read(sdkSessionId, { dir: this.#cwd })
      if (this.core.closed || !info) {
        return
      }
      const summary = info.summary && info.summary !== info.firstPrompt ? info.summary : undefined
      const title = info.customTitle || summary
      if (title) {
        this.#engineTitle = title
      }
    } catch {}
  }

  async #fetchContextUsage(): Promise<ContextUsage | undefined> {
    const query = this.#query
    if (typeof query?.getContextUsage !== 'function') {
      return undefined
    }
    try {
      const raw = await query.getContextUsage()
      if (this.core.closed) {
        return undefined
      }
      const usage: ContextUsage = {
        categories: raw.categories.map((c) => ({
          name: c.name,
          tokens: c.tokens,
          color: c.color,
        })),
        totalTokens: raw.totalTokens,
        maxTokens: raw.maxTokens,
        percentage: raw.percentage,
        model: raw.model,
      }
      this.core.emit({ type: 'context_usage', usage })
      return usage
    } catch {
      return undefined
    }
  }

  protected async reportFacts(): Promise<SessionReportFacts> {
    const [live] = await Promise.all([
      withDeadline(this.#fetchContextUsage(), REPORT_PROBE_TIMEOUT_MS),
      withDeadline(this.#syncEffort(), REPORT_PROBE_TIMEOUT_MS),
      withDeadline(
        this.refreshUsage().catch(() => undefined),
        REPORT_PROBE_TIMEOUT_MS,
      ),
    ])
    const context: LiveContext | undefined = live
      ? { totalTokens: live.totalTokens, maxTokens: live.maxTokens, categories: live.categories, measured: 'live' }
      : liveContextFromReading(this.core.log.contextUsage)
    return { vendor: 'anthropic', context, rateLimits: true }
  }

  // The account-level reading only ever moved at a turn boundary before this, so a gateway whose sessions were all
  // idle served whatever it last heard, for days, with nothing saying how old it was. An attach and a profiles read
  // are the other two moments someone is actually looking at the number.
  async refreshUsage(minIntervalMs = USAGE_REFRESH_MIN_MS): Promise<void> {
    if (Date.now() - this.#lastRateLimitPoll < minIntervalMs) {
      return
    }
    await this.#fetchRateLimits()
  }

  async #fetchRateLimits(): Promise<void> {
    this.#lastRateLimitPoll = Date.now()
    const query = this.#query as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> } | undefined
    const fetchUsage = query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof fetchUsage !== 'function') {
      return
    }
    try {
      const usage = (await fetchUsage.call(query)) as UsageRateLimits
      if (this.core.closed) {
        return
      }
      const subscriptionType = usage.subscription_type
      if (subscriptionType && subscriptionType !== this.#subscriptionType) {
        this.#subscriptionType = subscriptionType
        this.core.emit({ type: 'plan_info', subscriptionType })
      }
      for (const body of rateLimitEventsFromUsage(usage)) {
        this.core.emit(body)
      }
    } catch {}
  }

  #canUseTool: CanUseTool = (toolName, input, options) => {
    const id = randomUUID()
    const { timeoutMs, expiresAt } = this.approvalDeadline()
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
      expiresAt,
    }
    const questionBehavior = this.config.questionBehavior ?? 'ask'
    if (toolName === 'AskUserQuestion' && questionBehavior !== 'ask') {
      delete request.expiresAt
      return Promise.resolve(this.#resolveQuestionByPolicy(request, questionBehavior))
    }
    if (this.#allowsShellToolByPolicy(toolName)) {
      delete request.expiresAt
      return Promise.resolve(this.#allowByPolicy(request))
    }
    return new Promise<PermissionResult>((resolve) => {
      this.core.requestApproval(request, {
        timeoutMs,
        respond: (decision, resolvedBy) => {
          resolve(permissionResult(request, decision))
          return approvalResolution(decision, resolvedBy)
        },
        after: () => this.#afterApproval(),
      })
      options.signal.addEventListener('abort', () => {
        this.core.resolveApproval(id, { behavior: 'deny', message: 'Turn aborted' }, 'policy')
      })
      this.core.setStatus('awaiting_approval')
    })
  }

  // Reading a shell never writes to it and the tools are offered to operator sessions only, so the read pair never
  // waits on a click; a write tool skips the card only under `allow`, and a grant request never does.
  #allowsShellToolByPolicy(toolName: string): boolean {
    const tool = this.config.shells ? shellToolOf(toolName) : undefined
    if (tool === undefined) {
      return false
    }
    return shellWriteToolOf(toolName) === undefined || !shellToolNeedsCard(toolName, this.config.shellAgentWrite)
  }

  #allowByPolicy(request: PermissionRequest): PermissionResult {
    this.core.resolveByPolicy(request, 'allow')
    return { behavior: 'allow', updatedInput: request.input, toolUseID: request.toolUseId }
  }

  #resolveQuestionByPolicy(request: PermissionRequest, mode: 'auto' | 'deny'): PermissionResult {
    if (!this.core.resolveQuestionByPolicy(request, mode)) {
      return { behavior: 'deny', message: QUESTIONS_DISABLED_MESSAGE, toolUseID: request.toolUseId }
    }
    return {
      behavior: 'allow',
      updatedInput: { ...request.input, answers: recommendedAnswers(request.input) },
      toolUseID: request.toolUseId,
    }
  }

  #afterApproval(): void {
    if (this.core.pendingCount > 0) {
      return
    }
    const endedWhileBlocked = this.#turnOverWhileBlocked
    this.#turnOverWhileBlocked = false
    if (endedWhileBlocked) {
      this.core.setStatus('idle')
    } else if (this.core.status === 'awaiting_approval') {
      this.core.setStatus('running')
    }
  }

  // Summarising is work even when the engine calls the turn that asked for it over, and a
  // session that reports idle mid-compaction invites a prompt the engine cannot take yet.
  #holdIdleWhileCompacting(status: SessionStatus): boolean {
    if (status === 'idle' && this.#compactionId !== undefined) {
      this.#idleWhileCompacting = true
      return true
    }
    this.#idleWhileCompacting = false
    return false
  }

  // The checklist emit must follow the fan-out: emitting from inside `observe` appends seq n+1 and
  // delivers it before seq n, and every reducer's `seq <= lastSeq` dedupe then drops the message.
  #followChecklist(body: SessionEventBody): void {
    const todos = checklistFromBody(body)
    if (todos || body.type === 'conversation_reset') {
      this.#tasks.reset()
    }
    const items = todos ?? this.#tasks.observe(body)
    if (items && !sameChecklist(this.core.log.checklist, items)) {
      this.core.emit({ type: 'checklist', items })
    }
  }
}

function permissionResult(request: PermissionRequest, decision: PermissionDecision): PermissionResult {
  if (decision.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: decision.updatedInput ?? request.input, toolUseID: request.toolUseId }
  }
  return { behavior: 'deny', message: decision.message ?? 'Denied', interrupt: decision.interrupt, toolUseID: request.toolUseId }
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
