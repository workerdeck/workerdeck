import { randomUUID } from 'node:crypto'
import {
  ENGINE_CAPABILITIES,
  errorMessage,
  supportsPermissionMode,
  tokenUsageFromWire,
  type ChecklistItem,
  type PermissionMode,
  type PermissionRequest,
  type ProfileEngine,
  type SessionEventBody,
  type SessionInfo,
} from '@workerdeck/protocol'
import { attachmentKind, normalizeMediaType, type AttachmentInput } from '../../lib/attachments.ts'
import { sameChecklist } from '../../lib/checklist.ts'
import { agentResetFields } from '../../lib/context-reset.ts'
import { assertEffort, effortDefaultFor, modelEfforts } from '../../lib/effort.ts'
import { EngineRunner, type SessionReportFacts } from '../../lib/engine-runner.ts'
import { resolveInstructions } from '../../lib/instructions.ts'
import { JsonRpcError } from '../../lib/jsonrpc-stdio.ts'
import { withPeerContext } from '../../lib/peers.ts'
import { approvalResolution, type CloseReason, type RunnerCoreHooks } from '../../lib/runner-core.ts'
import { liveContextFromReading } from '../../lib/session-report.ts'
import type { ClearContextOptions, EngineRunnerConfig, Runner, SendMessageOptions, SleepResult } from '../../runner-interface.ts'
import type { ModelCatalog } from '../adapter.ts'
import { asReplay } from '../codex/history.ts'
import type {
  AcpCommand,
  AcpConfigOption,
  AcpConnectFn,
  AcpConnection,
  AcpContentBlock,
  AcpInitializeResponse,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPromptResponse,
  AcpSessionResponse,
  AcpSessionUpdate,
} from './types.ts'
import { AcpTranscript, toolName } from './updates.ts'

// What differs between ACP agents: how the session's instructions travel, which mode id each permission mode is, and
// how the agent names the model and thinking-level options.
export type AcpDialect = {
  engine: ProfileEngine
  label: string
  vendor: string
  catalog: ModelCatalog
  sessionMeta(instructions: string | undefined): Record<string, unknown> | undefined
  modeId(mode: PermissionMode): string | undefined
  modelOption: string
  effortOption: string
  modeOption: string
}

export type AcpRunnerConfig = EngineRunnerConfig & {
  connectFn: AcpConnectFn
  childEnv: Record<string, string>
  authMethod?: string
  dialect: AcpDialect
  backfillHistory?: boolean
}

type QueuedPrompt = { prompt: AcpContentBlock[] }

type ActiveTurn = {
  nonce: string
  startedAt: number
  interrupted: boolean
  latest: Promise<AcpPromptResponse>
  steers: number
  finished: Promise<void>
  finish: () => void
}

const SESSION_NOT_FOUND = -32002

function isMissingSession(error: unknown): boolean {
  if (!(error instanceof JsonRpcError)) {
    return false
  }
  return error.code === SESSION_NOT_FOUND || /session not found|failed to read session/i.test(error.message)
}

function isAuthError(error: unknown): boolean {
  return error instanceof JsonRpcError && /authentication required/i.test(error.message)
}

function stopError(stopReason: string | undefined): string | undefined {
  switch (stopReason) {
    case undefined:
    case 'end_turn': {
      return undefined
    }
    case 'cancelled': {
      return 'interrupted'
    }
    case 'max_tokens': {
      return 'the model hit its output token limit'
    }
    case 'max_turn_requests': {
      return 'the agent hit its per-turn request limit'
    }
    case 'refusal': {
      return 'the model refused to continue'
    }
    default: {
      return `the agent stopped (${stopReason})`
    }
  }
}

function select(optionId: string | undefined): AcpPermissionOutcome {
  return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
}

export class AcpRunner extends EngineRunner<AcpRunnerConfig> implements Runner {
  readonly #cwd: string
  readonly #dialect: AcpDialect
  readonly #instructions: string | undefined
  #sessionId: string | undefined
  #materialized: boolean
  #connection: AcpConnection | undefined
  #sessionOpen = false
  #engineVersion: string | undefined
  #engineTitle: string | undefined
  #model: string | undefined
  #effort: string | undefined
  #effortExplicit: boolean
  #permissionMode: PermissionMode
  #applied: Record<string, string | undefined> = {}
  #queue: QueuedPrompt[] = []
  #turnChain: Promise<void> = Promise.resolve()
  #backfill: Promise<void> | undefined
  #backfillPending = false
  #activeTurn: ActiveTurn | undefined
  #clearsPending = 0
  #started = false
  #asleep = false
  #replaying = false
  #numTurns = 0
  #commands: AcpCommand[] = []
  #context: { used: number; size: number } | undefined
  readonly #transcript: AcpTranscript

  constructor(config: AcpRunnerConfig, id: string = randomUUID()) {
    super(config, id, Date.now())
    const dialect = config.dialect
    const mode = config.permissionMode ?? 'default'
    if (!supportsPermissionMode(dialect.engine, mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the ${dialect.engine} engine`)
    }
    if (config.forkSession) {
      throw new Error(`the ${dialect.engine} engine cannot fork a session`)
    }
    if (!config.cwd) {
      throw new Error(`the ${dialect.engine} engine requires a cwd`)
    }
    this.#cwd = config.cwd
    this.#dialect = dialect
    this.#permissionMode = mode
    this.#model = config.model ?? dialect.catalog.defaultModel
    this.#effortExplicit = config.reasoningEffort !== undefined
    this.#effort = config.reasoningEffort ?? effortDefaultFor(config.effortDefaults, dialect.catalog.models, this.#model)
    this.#sessionId = config.resume
    this.#materialized = config.resume !== undefined
    this.#instructions = resolveInstructions(config.instructions, { sessionId: id, cwd: config.cwd, profile: config.profile })
    this.#transcript = new AcpTranscript({
      emit: (body) => this.core.emit(body),
      model: () => this.#model,
      partials: () => this.config.includePartialMessages !== false,
      title: (title) => {
        this.#engineTitle = title
      },
      commands: (commands) => this.#setCommands(commands),
      configOptions: (options) => this.#observeOptions(options),
      mode: () => {},
      context: (used, size) => this.#observeContext(used, size),
      checklist: (items) => this.#emitChecklist(items),
    })
  }

  protected override coreHooks(): RunnerCoreHooks {
    return { prepare: (body) => (this.#replaying ? asReplay(body) : body) }
  }

  get sdkSessionId(): string | undefined {
    return this.#materialized ? this.#sessionId : undefined
  }

  get engineAsleep(): boolean {
    return this.#asleep
  }

  info(): SessionInfo {
    return {
      ...this.baseInfo(this.#engineTitle),
      sdkSessionId: this.sdkSessionId,
      cwd: this.#cwd,
      engine: this.#dialect.engine,
      capabilities: ENGINE_CAPABILITIES[this.#dialect.engine],
      model: this.#model,
      ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
      permissionMode: this.#permissionMode,
      canBypassPermissions: true,
      engineVersion: this.#engineVersion,
      totalCostUsd: this.core.cost.reportedCostUsd,
      numTurns: this.#numTurns || undefined,
      ...(this.#asleep ? { engineAsleep: true as const } : {}),
    }
  }

  backfilled(): Promise<void> {
    return this.#backfill ?? Promise.resolve()
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#turnChain
    }
    this.#started = true
    if (this.config.resume && this.config.backfillHistory !== false) {
      this.#backfillPending = true
      this.#backfill = this.#turnChain.then(() => this.#backfillHistory())
      this.#turnChain = this.#backfill
    } else {
      this.core.setStatus('idle')
    }
    if (this.config.startAsleep && !this.config.prompt) {
      this.#turnChain = this.#turnChain.then(() => {
        if (!this.#sleepRefusal()) {
          this.#sleepNow()
        }
      })
    }
    this.#emitCapabilities()
    if (this.config.prompt) {
      this.sendMessage(this.config.prompt)
    }
    return this.#turnChain
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    this.assertAccepting()
    if (text.trim() === '/clear' && !attachments?.length && !options?.origin) {
      void this.clearContext().catch((error: unknown) => {
        this.core.emit({ type: 'session_error', message: `could not clear the conversation: ${errorMessage(error)}` })
      })
      return
    }
    const prompt = this.#buildPrompt(withPeerContext(text, options), attachments ?? [])
    this.#wake()
    const echo = (): void => {
      this.echoUser(text, attachments, options)
    }
    if (this.#backfillPending) {
      this.#turnChain = this.#turnChain.then(echo)
    } else {
      echo()
    }
    const active = this.#activeTurn
    if (active && !active.interrupted && this.#connection && this.#sessionOpen && this.#clearsPending === 0) {
      this.#steer(active, prompt)
      return
    }
    this.#queue.push({ prompt })
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  pendingInput(): number {
    return this.#queue.length
  }

  async interrupt(): Promise<void> {
    this.core.settleAllApprovals({ behavior: 'deny', message: 'interrupted', interrupt: true }, 'policy')
    const active = this.#activeTurn
    if (active) {
      active.interrupted = true
      if (this.#connection && this.#sessionId) {
        this.#connection.notify('session/cancel', { sessionId: this.#sessionId })
      }
      await active.finished
    }
    await this.#turnChain
  }

  async clearContext(options?: ClearContextOptions): Promise<void> {
    this.assertAccepting()
    this.#clearsPending += 1
    const run = this.#turnChain
      .then(() => this.#clearNow(options))
      .finally(() => {
        this.#clearsPending -= 1
      })
    this.#turnChain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  async sleep(): Promise<SleepResult> {
    const refused = this.#sleepRefusal()
    if (refused) {
      return { ok: false, reason: refused }
    }
    this.#sleepNow()
    return { ok: true }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!supportsPermissionMode(this.#dialect.engine, mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the ${this.#dialect.engine} engine`)
    }
    this.#permissionMode = mode
    this.core.emit({ type: 'permission_mode_changed', mode })
    await this.#applyIdleOptions()
  }

  async setModel(model?: string): Promise<void> {
    if (this.#activeTurn) {
      throw new Error("cannot change the model mid-turn (the running turn's model is fixed)")
    }
    const models = this.#dialect.catalog.models
    this.#model = model ?? this.#dialect.catalog.defaultModel
    this.core.emit({ type: 'model_changed', model: this.#model })
    const fallback = effortDefaultFor(this.config.effortDefaults, models, this.#model)
    if (fallback !== undefined) {
      this.#effortExplicit = false
      this.#effort = fallback
    } else if (!this.#effortExplicit) {
      this.#effort = undefined
    }
    const supported = modelEfforts(models, this.#model)
    if (this.#effort !== undefined && supported && !supported.includes(this.#effort)) {
      this.#effort = undefined
    }
    if (this.#effort !== undefined) {
      this.core.emit({ type: 'effort_changed', effort: this.#effort })
    }
    await this.#applyIdleOptions()
  }

  async setEffort(effort?: string): Promise<void> {
    if (this.#activeTurn) {
      throw new Error('cannot change the thinking level mid-turn')
    }
    const models = this.#dialect.catalog.models
    assertEffort(effort, modelEfforts(models, this.#model))
    this.#effortExplicit = effort !== undefined
    this.#effort = effort ?? effortDefaultFor(this.config.effortDefaults, models, this.#model)
    this.core.emit({ type: 'effort_changed', effort: this.#effort ?? null })
    await this.#applyIdleOptions()
  }

  close(reason: CloseReason = 'client'): void {
    this.core.close(reason, () => {
      this.#queue.length = 0
      this.localCommands.clear()
      this.#connection?.close()
      this.#connection = undefined
      this.#sessionOpen = false
    })
  }

  protected async reportFacts(): Promise<SessionReportFacts> {
    const context = this.#context
      ? { totalTokens: this.#context.used, maxTokens: this.#context.size, measured: 'live' as const }
      : liveContextFromReading(this.core.log.contextUsage)
    return { vendor: this.#dialect.vendor, context, rateLimits: false }
  }

  #buildPrompt(text: string, attachments: readonly AttachmentInput[]): AcpContentBlock[] {
    const blocks: AcpContentBlock[] = []
    const context = this.localCommands.take()
    if (context) {
      blocks.push({ type: 'text', text: context })
    }
    for (const attachment of attachments) {
      const mediaType = normalizeMediaType(attachment.mediaType)
      switch (attachmentKind(mediaType)) {
        case 'image': {
          blocks.push({ type: 'image', data: attachment.data, mimeType: mediaType })
          break
        }
        case 'text': {
          blocks.push({
            type: 'text',
            text: `<attachment name="${attachment.name}" type="${mediaType}">\n${Buffer.from(attachment.data, 'base64').toString('utf8')}\n</attachment>`,
          })
          break
        }
        default: {
          throw new Error(`unsupported attachment media type for the ${this.#dialect.engine} engine: ${attachment.mediaType}`)
        }
      }
    }
    if (text) {
      blocks.push({ type: 'text', text })
    }
    return blocks
  }

  // agy answers a prompt sent mid-turn by ending the running prompt at once (`end_turn`, no usage) and carrying the
  // rest of the turn on the new one, so the turn settles on whichever prompt was sent last.
  #steer(active: ActiveTurn, prompt: AcpContentBlock[]): void {
    const connection = this.#connection
    const sessionId = this.#sessionId
    if (!connection || !sessionId) {
      this.#queue.push({ prompt })
      this.#turnChain = this.#turnChain.then(() => this.#runTurn())
      return
    }
    active.steers += 1
    active.latest = connection.request('session/prompt', { sessionId, prompt }) as Promise<AcpPromptResponse>
  }

  async #runTurn(): Promise<void> {
    if (this.core.closed) {
      return
    }
    const turn = this.#queue.shift()
    if (!turn) {
      return
    }
    this.core.setStatus('running')
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const active: ActiveTurn = {
      nonce: randomUUID(),
      startedAt: Date.now(),
      interrupted: false,
      latest: Promise.resolve({}),
      steers: 0,
      finished,
      finish,
    }
    this.#activeTurn = active
    this.#transcript.beginTurn(active.nonce)
    try {
      const connection = await this.#ensureSession()
      active.latest = connection.request('session/prompt', {
        sessionId: this.#sessionId,
        prompt: turn.prompt,
      }) as Promise<AcpPromptResponse>
      let response: AcpPromptResponse
      for (;;) {
        const current = active.latest
        response = await current
        if (current === active.latest) {
          break
        }
      }
      this.#materialized = true
      this.#finishTurn(active, response, stopError(response.stopReason))
    } catch (error) {
      if (!this.core.closed) {
        this.#finishTurn(active, {}, active.interrupted ? 'interrupted' : this.#turnError(error))
      }
    } finally {
      if (this.#activeTurn === active) {
        this.#activeTurn = undefined
      }
      active.finish()
    }
  }

  #turnError(error: unknown): string {
    if (isAuthError(error)) {
      return `${this.#dialect.label} is not signed in for this profile: save a Gemini API key in the profile's geminiHome, or run \`agy\` once and log in`
    }
    return errorMessage(error)
  }

  #finishTurn(active: ActiveTurn, response: AcpPromptResponse, error: string | undefined): void {
    this.#transcript.flush()
    this.#transcript.settleOpenTools(error ?? 'the turn ended before the tool reported a result')
    this.core.settleAllApprovals({ behavior: 'deny', message: 'Turn ended' }, 'policy')
    this.#numTurns += 1
    const usage = response.usage
    const wire = usage
      ? {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          cache_creation_input_tokens: usage.cachedWriteTokens ?? 0,
          cache_read_input_tokens: usage.cachedReadTokens ?? 0,
        }
      : undefined
    this.core.emitTurnResult({
      startedAt: active.startedAt,
      numTurns: this.#numTurns,
      result: error === undefined ? (this.#transcript.lastText ?? '') : undefined,
      errors: error === undefined ? undefined : [error],
      usage: wire,
      byModel: wire ? { [this.#model ?? 'unknown']: tokenUsageFromWire(wire) } : undefined,
      costs: true,
    })
    this.#emitContext()
    this.core.setStatus('idle')
  }

  async #ensureSession(): Promise<AcpConnection> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    const connection = this.#connection ?? (await this.#connect())
    if (!this.#sessionOpen) {
      await this.#openSession(connection)
    }
    return connection
  }

  async #connect(): Promise<AcpConnection> {
    const connection = this.config.connectFn({ env: this.config.childEnv, cwd: this.#cwd })
    this.#connection = connection
    this.#sessionOpen = false
    this.#applied = {}
    connection.onNotification((method, params) => this.#handleNotification(method, params))
    connection.onRequest((method, params, id) => this.#answerRequest(method, params, id))
    connection.onClose((message) => {
      if (this.#connection === connection) {
        this.#connection = undefined
        this.#sessionOpen = false
      }
      this.core.settleAllApprovals({ behavior: 'deny', message }, 'policy')
    })
    try {
      const init = (await connection.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'workerdeck', title: 'WorkerDeck' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })) as AcpInitializeResponse
      this.#engineVersion = init?.agentInfo?.version ?? this.#engineVersion
      if (this.config.authMethod) {
        await connection.request('authenticate', { methodId: this.config.authMethod })
      }
    } catch (error) {
      connection.close()
      if (this.#connection === connection) {
        this.#connection = undefined
      }
      throw error
    }
    return connection
  }

  #sessionParams(): Record<string, unknown> {
    const meta = this.#dialect.sessionMeta(this.#instructions)
    return { cwd: this.#cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) }
  }

  async #openSession(connection: AcpConnection): Promise<void> {
    const existing = this.#sessionId
    if (existing) {
      try {
        const result = (await connection.request('session/resume', { sessionId: existing, ...this.#sessionParams() })) as AcpSessionResponse
        this.#sessionOpen = true
        await this.#applyOptions(connection, result?.configOptions)
        return
      } catch (error) {
        if (!isMissingSession(error)) {
          throw error
        }
        this.core.emit({
          type: 'session_error',
          message: `${this.#dialect.label} has no record of this session (${existing}); a new one was started, so the model begins without the earlier conversation.`,
        })
      }
    }
    const result = (await connection.request('session/new', this.#sessionParams())) as AcpSessionResponse
    if (typeof result?.sessionId !== 'string') {
      throw new Error(`${this.#dialect.label} answered session/new without a session id`)
    }
    this.#sessionId = result.sessionId
    this.#materialized = false
    this.#sessionOpen = true
    await this.#applyOptions(connection, result.configOptions)
  }

  // A resumed or loaded session comes back on the agent's default model, so every option is sent again whenever its
  // reported value differs from ours.
  async #applyOptions(connection: AcpConnection, reported: AcpConfigOption[] | undefined): Promise<void> {
    if (reported) {
      this.#observeOptions(reported)
    }
    const wanted: Array<[string, string | undefined]> = [
      [this.#dialect.modelOption, this.#model],
      [this.#dialect.effortOption, this.#effort],
      [this.#dialect.modeOption, this.#dialect.modeId(this.#permissionMode)],
    ]
    for (const [configId, value] of wanted) {
      if (value === undefined || this.#applied[configId] === value) {
        continue
      }
      try {
        const result = (await connection.request('session/set_config_option', { sessionId: this.#sessionId, configId, value })) as {
          configOptions?: AcpConfigOption[]
        }
        this.#applied[configId] = value
        if (result?.configOptions) {
          this.#observeOptions(result.configOptions)
        }
      } catch (error) {
        this.core.emit({ type: 'session_error', message: `could not set ${configId} to '${value}': ${errorMessage(error)}` })
      }
    }
  }

  async #applyIdleOptions(): Promise<void> {
    const connection = this.#connection
    if (connection && this.#sessionOpen && !this.#activeTurn) {
      await this.#applyOptions(connection, undefined)
    }
  }

  #observeOptions(options: AcpConfigOption[]): void {
    for (const option of options) {
      if (option.currentValue !== undefined) {
        this.#applied[option.id] = option.currentValue
      }
    }
  }

  async #backfillHistory(): Promise<void> {
    try {
      const connection = await this.#connect()
      this.#replaying = true
      this.#transcript.setReplaying(true)
      let result: AcpSessionResponse
      try {
        result = (await connection.request('session/load', { sessionId: this.#sessionId, ...this.#sessionParams() })) as AcpSessionResponse
      } finally {
        this.#transcript.setReplaying(false)
        this.#replaying = false
      }
      this.#sessionOpen = true
      await this.#applyOptions(connection, result?.configOptions)
    } catch (error) {
      if (!this.core.closed) {
        this.core.emit({ type: 'session_error', message: `could not load this session's history: ${errorMessage(error)}` })
      }
    } finally {
      this.#backfillPending = false
      if (!this.core.closed) {
        this.core.setStatus('idle')
      }
    }
  }

  async #clearNow(options?: ClearContextOptions): Promise<void> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    const connection = this.#connection
    const previous = this.#sessionId
    if (connection && previous && this.#sessionOpen) {
      void connection.request('session/close', { sessionId: previous }).catch(() => undefined)
    }
    this.#sessionId = undefined
    this.#materialized = false
    this.#sessionOpen = false
    this.#applied = {}
    if (connection) {
      await this.#openSession(connection)
    }
    this.core.settleAllApprovals({ behavior: 'deny', message: 'the conversation was cleared' }, 'policy')
    this.localCommands.clear()
    this.core.emit({ type: 'conversation_reset', sdkSessionId: this.sdkSessionId, ...agentResetFields(options) })
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
    if (this.#activeTurn || this.#queue.length > 0 || this.#clearsPending > 0 || this.#backfillPending) {
      return 'a turn is on its way'
    }
    return undefined
  }

  #sleepNow(): void {
    if (this.#asleep) {
      return
    }
    const connection = this.#connection
    this.#asleep = true
    this.#connection = undefined
    this.#sessionOpen = false
    if (connection && this.#sessionId) {
      void connection.request('session/close', { sessionId: this.#sessionId }).catch(() => undefined)
    }
    connection?.close()
    this.core.emit({ type: 'engine_sleep', asleep: true })
  }

  #wake(): void {
    if (!this.#asleep) {
      return
    }
    this.#asleep = false
    this.core.emit({ type: 'engine_sleep', asleep: false })
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      return
    }
    const payload = params as { sessionId?: string; update?: AcpSessionUpdate } | null
    if (!payload?.update || (payload.sessionId !== undefined && payload.sessionId !== this.#sessionId)) {
      return
    }
    this.#transcript.apply(payload.update)
  }

  async #answerRequest(method: string, params: unknown, wireId: string | number): Promise<unknown> {
    if (method === 'session/request_permission') {
      return this.#requestPermission(params as AcpPermissionRequest, wireId)
    }
    throw new JsonRpcError(-32601, `workerdeck does not handle agent request '${method}'`)
  }

  #requestPermission(params: AcpPermissionRequest, wireId: string | number): Promise<AcpPermissionOutcome> {
    const options = Array.isArray(params?.options) ? params.options : []
    const allow = options.find((option) => option.kind === 'allow_once')
    const reject = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always')
    if (this.#permissionMode === 'bypassPermissions' && allow) {
      return Promise.resolve(select(allow.optionId))
    }
    const call = params.toolCall
    const id = randomUUID()
    const { timeoutMs, expiresAt } = this.approvalDeadline()
    const request: PermissionRequest = {
      id,
      toolName: toolName(call),
      input: (call.rawInput as Record<string, unknown> | undefined) ?? {},
      toolUseId: call.toolCallId ? this.#transcript.toolUseId(call.toolCallId) : id,
      title: call.title,
      expiresAt,
    }
    return new Promise<AcpPermissionOutcome>((resolve) => {
      this.core.requestApproval(request, {
        timeoutMs,
        wireId,
        respond: (decision, resolvedBy) => {
          if (decision.behavior === 'allow') {
            if (!allow) {
              resolve(select(reject?.optionId))
              return approvalResolution({ behavior: 'deny', message: 'the agent offered no one-time allow' }, 'policy')
            }
            resolve(select(allow.optionId))
          } else {
            resolve(decision.interrupt ? select(undefined) : select(reject?.optionId))
          }
          return approvalResolution(decision, resolvedBy)
        },
        after: (_resolution, decision) => {
          if (decision.behavior === 'deny' && decision.interrupt && this.#activeTurn && !this.#activeTurn.interrupted) {
            void this.interrupt()
          }
          if (!this.core.closed && this.core.pendingCount === 0 && this.core.status === 'awaiting_approval') {
            this.core.setStatus('running')
          }
        },
      })
      if (this.#activeTurn && this.core.pendingCount > 0) {
        this.core.setStatus('awaiting_approval')
      }
    })
  }

  #setCommands(commands: AcpCommand[]): void {
    this.#commands = commands
    this.#emitCapabilities()
  }

  #emitCapabilities(): void {
    this.core.emit({
      type: 'capabilities',
      models: this.#dialect.catalog.models,
      defaultModel: this.#dialect.catalog.defaultModel,
      commands: this.#commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
      })),
    })
  }

  #observeContext(used: number, size: number): void {
    if (used <= 0 || size <= 0) {
      return
    }
    this.#context = { used, size }
    if (!this.#activeTurn) {
      this.#emitContext()
    }
  }

  #emitContext(): void {
    const context = this.#context
    if (!context) {
      return
    }
    const body: SessionEventBody = {
      type: 'context_usage',
      usage: {
        categories: [],
        totalTokens: context.used,
        maxTokens: context.size,
        percentage: Math.min(100, (context.used / context.size) * 100),
        model: this.#model,
      },
    }
    this.core.emit(body)
  }

  #emitChecklist(items: ChecklistItem[]): void {
    if (!sameChecklist(this.core.log.checklist, items)) {
      this.core.emit({ type: 'checklist', items })
    }
  }
}
