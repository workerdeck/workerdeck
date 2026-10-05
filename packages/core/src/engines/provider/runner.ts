import { randomUUID } from 'node:crypto'
import { ToolLoopAgent, generateText, isStepCount, type LanguageModel, type ModelMessage, type ToolCallPart, type ToolSet } from 'ai'
import {
  ENGINE_CAPABILITIES,
  snapshotRetains,
  supportsPermissionMode,
  type McpServerStatusInfo,
  type PermissionMode,
  type PermissionRequest,
  type ProviderContextWindow,
  type SessionInfo,
  type ToolExecutionBackend,
  type ByModel,
  tokenUsageFromWire,
  errorMessage,
} from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import { type AttachmentInput, normalizeMediaType } from '../../lib/attachments.ts'
import type {
  ClearContextOptions,
  EngineRunnerConfig,
  ParkedExecution,
  PermissionDecision,
  Runner,
  RunnerSnapshot,
  SendMessageOptions,
} from '../../runner-interface.ts'
import type { ToolExecutionCall, ToolExecutionResult, ToolExecutor } from '../../executors/tool-executor.ts'
import { EngineRunner, type SessionReportFacts } from '../../lib/engine-runner.ts'
import { providerVendor } from '../../lib/session-report.ts'
import { approvalResolution, type ApprovalResolution, type CloseReason } from '../../lib/runner-core.ts'
import { withPeerContext } from '../../lib/peers.ts'
import { agentResetFields } from '../../lib/context-reset.ts'
import { resolveInstructions } from '../../lib/instructions.ts'
import {
  TurnStream,
  addUsage,
  newTurnUsage,
  resolveContextWindow,
  settledToolCallIds,
  stepContextTokens,
  wireUsage,
  type TurnUsage,
} from './turn.ts'

export type AiSdkRunnerConfig = EngineRunnerConfig & {
  languageModel: LanguageModel
  tools?: ToolSet
  maxSteps?: number
  executor?: ToolExecutor
  executableTools?: string[]
  vfs?: SandboxVfs
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  executionBackend?: ToolExecutionBackend
  toolTitles?: Record<string, string>
  shouldApprove?: (call: { toolName: string; input: unknown }) => boolean
  resolveModel?: (modelId: string | undefined) => LanguageModel
  contextWindow?: ProviderContextWindow
  reportMcpServers?: () => Promise<McpServerStatusInfo[] | undefined>
  onClose?: () => void | Promise<void>
  restore?: RunnerSnapshot
}

export type PendingToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
  parkable?: boolean
  expiresAt?: number
}

export type AiSdkSessionState = {
  messages: ModelMessage[]
  pendingToolCalls: PendingToolCall[]
  dispatched: string[]
  numTurns: number
  contextTokens?: number
  turnAccum?: TurnUsage
  permissionMode: PermissionMode
  model?: string
  lastActivityAt?: number
  parkedAt?: number
  pendingLocalCommands?: string[]
}

export type ToolCallOutput = { type: 'text'; value: string } | { type: 'json'; value: unknown }

export class AiSdkRunner extends EngineRunner<AiSdkRunnerConfig> implements Runner {
  readonly #instructions: string | undefined
  #model: LanguageModel
  #permissionMode: PermissionMode
  #messages: ModelMessage[] = []
  #pendingToolCalls = new Map<string, PendingToolCall>()
  #dispatched = new Set<string>()
  #turnChain: Promise<void> = Promise.resolve()
  #abort: AbortController | undefined
  #turnAccum: TurnUsage | undefined
  #numTurns = 0
  #contextTokens: number | undefined
  #started = false
  #parked = false
  #modelAlias: string | undefined

  constructor(config: AiSdkRunnerConfig, id: string = randomUUID()) {
    super(config, config.restore?.id ?? id, config.restore?.createdAt ?? Date.now())
    const mode = config.permissionMode ?? 'default'
    assertPermissionMode(mode)
    this.#model = config.languageModel
    this.#permissionMode = mode
    this.#modelAlias = config.model
    this.#instructions = resolveInstructions(config.instructions, { sessionId: this.id, cwd: config.cwd, profile: config.profile })
    if (config.restore) {
      this.#restore(config.restore)
    }
  }

  #restore(snapshot: RunnerSnapshot): void {
    if (snapshot.engine !== 'provider') {
      throw new Error(`cannot restore a '${snapshot.engine}' snapshot into the AI SDK engine`)
    }
    const state = snapshot.state as AiSdkSessionState | undefined
    if (!state || !Array.isArray(state.messages)) {
      throw new Error('session snapshot is missing its provider-engine state')
    }
    this.core.log.restore(snapshot.events, snapshot.seq, state.lastActivityAt)
    this.#messages = [...state.messages]
    this.localCommands.restore(state.pendingLocalCommands ?? [])
    for (const call of state.pendingToolCalls) {
      const legacy = (call as { deferred?: boolean }).deferred
      this.#pendingToolCalls.set(call.toolCallId, legacy === undefined ? call : { ...call, parkable: call.parkable ?? legacy })
    }
    this.#dispatched = new Set(state.dispatched)
    this.#numTurns = state.numTurns
    this.#contextTokens = state.contextTokens
    this.#turnAccum = state.turnAccum ? { ...state.turnAccum } : undefined
    if (this.#turnAccum && state.parkedAt !== undefined) {
      this.#turnAccum.startedAt += Date.now() - state.parkedAt
    }
    this.#permissionMode = state.permissionMode
    this.core.restoreStatus(this.#pendingToolCalls.size > 0 ? 'parked' : 'idle')
    if (state.model !== undefined && state.model !== this.#modelAlias && this.config.resolveModel) {
      this.#modelAlias = state.model
      this.#model = this.config.resolveModel(state.model)
    }
  }

  get messages(): ModelMessage[] {
    return [...this.#messages]
  }

  get pendingToolCalls(): PendingToolCall[] {
    return [...this.#pendingToolCalls.values()]
  }

  get vfs(): SandboxVfs | undefined {
    return this.config.vfs
  }

  info(): SessionInfo {
    return {
      ...this.baseInfo(),
      // Never process.cwd(): this engine opens no directory, and the gateway's own deploy path
      // has no business on a client surface.
      cwd: this.config.cwd ?? '',
      engine: 'provider',
      capabilities: this.config.shouldApprove
        ? { ...ENGINE_CAPABILITIES.provider, interactiveApprovals: true }
        : ENGINE_CAPABILITIES.provider,
      model: this.#modelId(),
      permissionMode: this.#permissionMode,
      numTurns: this.#numTurns || undefined,
    }
  }

  #turnByModel(accum: TurnUsage): ByModel {
    return { [this.#modelId() ?? 'unknown']: tokenUsageFromWire(wireUsage(accum)) }
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#turnChain
    }
    this.#started = true
    this.#emitToolTitles()
    if (this.config.restore) {
      return this.#turnChain
    }
    this.core.setStatus('idle')
    if (this.config.prompt) {
      this.sendMessage(this.config.prompt)
    }
    return this.#turnChain
  }

  park(): RunnerSnapshot | undefined {
    if (this.core.closed || this.#parked) {
      return undefined
    }
    if (this.#abort || !this.#restingOnDeferred()) {
      return undefined
    }
    this.core.setStatus('parked')
    const snapshot = this.#buildSnapshot()
    this.#parked = true
    this.core.clearSubscribers()
    this.localCommands.clear()
    this.#runOnClose()
    return snapshot
  }

  snapshot(): RunnerSnapshot | undefined {
    if (this.core.closed || this.#parked || this.#abort) {
      return undefined
    }
    if (this.#pendingToolCalls.size > 0 && !this.#restingOnDeferred()) {
      return undefined
    }
    return this.#buildSnapshot()
  }

  #buildSnapshot(): RunnerSnapshot {
    const parked: ParkedExecution[] = [...this.#pendingToolCalls.values()].map((call) => ({
      executionId: call.toolCallId,
      toolName: call.toolName,
      expiresAt: call.expiresAt,
    }))
    const pendingLocalCommands = this.localCommands.materialize()
    const state: AiSdkSessionState = {
      messages: this.#messages,
      pendingToolCalls: [...this.#pendingToolCalls.values()],
      dispatched: [...this.#dispatched],
      numTurns: this.#numTurns,
      ...(this.#contextTokens === undefined ? {} : { contextTokens: this.#contextTokens }),
      turnAccum: this.#turnAccum ? { ...this.#turnAccum } : undefined,
      permissionMode: this.#permissionMode,
      model: this.#modelAlias,
      lastActivityAt: this.core.log.lastActivityAt,
      parkedAt: Date.now(),
      ...(pendingLocalCommands.length ? { pendingLocalCommands } : {}),
    }
    return {
      engine: 'provider',
      id: this.id,
      createdAt: this.createdAt,
      seq: this.core.log.seq,
      events: this.core.log.events.filter((event) => snapshotRetains(event)),
      vfs: this.config.vfs?.snapshot(),
      parked,
      state,
    }
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    this.assertAccepting()
    const modelText = withPeerContext(text, options)
    const files = (attachments ?? []).map((attachment) => ({
      type: 'file' as const,
      data: attachment.data,
      mediaType: normalizeMediaType(attachment.mediaType),
      filename: attachment.name,
    }))
    const context = this.localCommands.take()
    const content =
      files.length || context
        ? [
            ...(context ? [{ type: 'text' as const, text: context }] : []),
            ...files,
            ...(modelText ? [{ type: 'text' as const, text: modelText }] : []),
          ]
        : modelText
    this.#messages.push({ role: 'user', content })
    this.echoUser(text, attachments, options)
    this.#scheduleTurn()
  }

  protected override assertAccepting(): void {
    if (this.#parked) {
      throw new Error('session is parked')
    }
    super.assertAccepting()
  }

  resolveToolCall(toolCallId: string, output: ToolCallOutput, options?: { isError?: boolean }): boolean {
    if (!this.#settlePendingCall(toolCallId, output, options?.isError === true)) {
      return false
    }
    if (this.#pendingToolCalls.size === 0) {
      this.#scheduleTurn()
    }
    return true
  }

  #settlePendingCall(toolCallId: string, output: ToolCallOutput, isError: boolean): boolean {
    const pending = this.#pendingToolCalls.get(toolCallId)
    if (!pending || this.core.closed || this.#parked) {
      return false
    }
    this.#pendingToolCalls.delete(toolCallId)
    let insertAt = this.#messages.length
    while (insertAt > 0 && this.#messages[insertAt - 1]!.role === 'user') {
      insertAt--
    }
    this.#messages.splice(insertAt, 0, {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: pending.toolName,
          output: (isError ? { type: 'error-text', value: textValue(output) } : output) as never,
        },
      ],
    })
    this.core.emit({
      type: 'user_message',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: textValue(output),
            is_error: isError || undefined,
          },
        ],
      },
      parentToolUseId: null,
      synthetic: true,
      uuid: randomUUID(),
    })
    return true
  }

  #afterApproval(toolCallId: string, resolution: ApprovalResolution, decision: PermissionDecision): void {
    if (decision.behavior === 'allow') {
      this.#dispatchSingle(toolCallId, decision.updatedInput)
      return
    }
    this.#applyExecutionResult(toolCallId, { status: 'failed', reason: 'permission_denied', error: resolution.message ?? '' })
    if (decision.interrupt) {
      void this.interrupt()
    }
  }

  emitFileDelivered(file: { path: string; bytes: number; description?: string }): void {
    if (this.core.closed || this.#parked) {
      return
    }
    this.core.emit({ type: 'file_delivered', ...file })
  }

  async generateDigest(prompt: string): Promise<string> {
    const result = await generateText({
      model: this.#model,
      prompt,
      abortSignal: this.#abort?.signal,
    })
    if (this.#turnAccum) {
      addUsage(this.#turnAccum, result.usage)
    }
    return result.text
  }

  async clearContext(options?: ClearContextOptions): Promise<void> {
    if (this.core.terminal) {
      throw new Error('session is closed')
    }
    const run = this.#turnChain.then(() => {
      if (this.core.closed) {
        throw new Error('session is closed')
      }
      // Waiting cannot resolve parked external work - a bridged result is owed by a client that
      // may answer in two days, and the messages it splices into are what a clear would drop.
      if (this.#pendingToolCalls.size > 0) {
        throw new Error('cannot clear context while tool calls are outstanding')
      }
      this.#messages = []
      this.#contextTokens = undefined
      this.localCommands.clear()
      this.core.emit({ type: 'conversation_reset', ...agentResetFields(options) })
    })
    this.#turnChain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  async interrupt(): Promise<void> {
    this.core.settleAllApprovals({ behavior: 'deny', message: 'interrupted' }, 'client', false)
    if (this.#abort) {
      this.#abort.abort()
    } else if (this.#pendingToolCalls.size > 0) {
      const accum = this.#turnAccum ?? newTurnUsage()
      for (const call of Array.from(this.#pendingToolCalls.values())) {
        this.#settlePendingCall(call.toolCallId, { type: 'text', value: 'interrupted' }, true)
      }
      this.#dispatched.clear()
      this.#failTurn(accum, 'interrupted')
    }
    await this.#turnChain
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    assertPermissionMode(mode)
    this.#permissionMode = mode
    this.core.emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    const resolve = this.config.resolveModel
    if (!resolve) {
      throw new Error('set_model is not supported by this session')
    }
    this.#model = resolve(model)
    this.#modelAlias = model
    this.core.emit({ type: 'model_changed', model })
  }

  close(reason: CloseReason = 'client'): void {
    if (this.#parked) {
      return
    }
    const closed = this.core.close(reason, () => {
      this.#abort?.abort()
      this.localCommands.clear()
      this.#pendingToolCalls.clear()
      this.#dispatched.clear()
    })
    if (closed) {
      this.#runOnClose()
    }
  }

  #runOnClose(): void {
    try {
      void Promise.resolve(this.config.onClose?.()).catch(() => {})
    } catch {}
  }

  #scheduleTurn(): void {
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  settleExecution(executionId: string, result: ToolExecutionResult): boolean {
    if (this.core.closed || this.#parked) {
      return false
    }
    if (!this.#pendingToolCalls.has(executionId)) {
      return false
    }
    this.#applyExecutionResult(executionId, result)
    return true
  }

  #dispatchPending(): void {
    const executor = this.config.executor
    if (!executor) {
      return
    }
    const executable = this.config.executableTools
    const needsApproval = this.#permissionMode === 'default' && this.config.shouldApprove
    const inFlight: Array<Promise<unknown>> = []
    let anyDeferred = false
    let anyAwaiting = false
    for (const call of Array.from(this.#pendingToolCalls.values())) {
      if (executable && !executable.includes(call.toolName)) {
        continue
      }
      if (this.#dispatched.has(call.toolCallId)) {
        continue
      }
      if (needsApproval && needsApproval({ toolName: call.toolName, input: call.input as Record<string, unknown> })) {
        if (this.core.findApproval((request) => request.toolUseId === call.toolCallId) !== undefined) {
          anyAwaiting = true
          continue
        }
        this.#requestApproval(call)
        anyAwaiting = true
        continue
      }
      this.#dispatched.add(call.toolCallId)
      const dispatched = this.#dispatchCall(executor, call)
      anyDeferred ||= dispatched.deferred
      inFlight.push(dispatched.promise)
    }
    if (anyAwaiting) {
      this.core.setStatus('awaiting_approval')
    }
    if (anyDeferred) {
      void Promise.allSettled(inFlight).then(() => this.#announceParked())
    }
  }

  #requestApproval(call: PendingToolCall): void {
    const { timeoutMs, expiresAt } = this.approvalDeadline()
    const request: PermissionRequest = {
      id: randomUUID(),
      toolName: call.toolName,
      input: call.input as Record<string, unknown>,
      toolUseId: call.toolCallId,
      title: `Agent wants to run ${call.toolName}`,
      displayName: call.toolName,
      expiresAt,
    }
    this.core.requestApproval(request, {
      timeoutMs,
      respond: (decision, resolvedBy) => approvalResolution(decision, resolvedBy, 'Permission denied by user'),
      after: (resolution, decision) => this.#afterApproval(call.toolCallId, resolution, decision),
    })
  }

  #dispatchSingle(toolCallId: string, updatedInput?: Record<string, unknown>): void {
    const executor = this.config.executor
    if (!executor) {
      return
    }
    const call = this.#pendingToolCalls.get(toolCallId)
    if (!call || this.#dispatched.has(toolCallId)) {
      return
    }
    if (updatedInput !== undefined) {
      this.#amendToolInput(call, updatedInput)
    }
    this.#dispatched.add(toolCallId)
    const dispatched = this.#dispatchCall(executor, call)
    if (dispatched.deferred) {
      void dispatched.promise.then(() => this.#announceParked())
    }
  }

  // The next leg must see the call the way it ran, not the way the model wrote it.
  #amendToolInput(call: PendingToolCall, input: Record<string, unknown>): void {
    call.input = input
    for (let i = this.#messages.length - 1; i >= 0; i--) {
      const message = this.#messages[i]!
      if (
        message.role !== 'assistant' ||
        !Array.isArray(message.content) ||
        !message.content.some((part) => callsTool(part, call.toolCallId))
      ) {
        continue
      }
      const content = message.content.map((part) => (callsTool(part, call.toolCallId) ? { ...part, input } : part))
      this.#messages[i] = { ...message, content }
      return
    }
  }

  #dispatchCall(executor: ToolExecutor, call: PendingToolCall): { deferred: boolean; promise: Promise<void> } {
    const toolCall: ToolExecutionCall = {
      executionId: call.toolCallId,
      sessionId: this.id,
      tool: call.toolName,
      input: call.input,
      vfs: this.config.vfs,
      limits: this.config.executionLimits,
      signal: this.#abort?.signal,
    }
    const profile = executor.describe?.(toolCall) ?? {}
    call.parkable = profile.deferred === true ? true : undefined
    call.expiresAt = profile.timeoutMs === undefined ? undefined : Date.now() + profile.timeoutMs
    this.core.emit({
      type: 'execution_dispatched',
      executionId: call.toolCallId,
      toolName: call.toolName,
      backend: profile.backend ?? this.config.executionBackend ?? 'server',
      deferred: call.parkable,
      expiresAt: call.expiresAt,
    })
    const promise = executor
      .dispatch(toolCall)
      .then((dispatch) => {
        // 'pending' means the result arrives later, through settleExecution().
        if (dispatch.status === 'settled') {
          this.#applyExecutionResult(call.toolCallId, dispatch.result)
        }
      })
      .catch((error: unknown) => {
        this.#applyExecutionResult(call.toolCallId, {
          status: 'failed',
          reason: 'dispatch_error',
          error: errorMessage(error),
        })
      })
    return { deferred: call.parkable === true, promise }
  }

  #announceParked(): void {
    if (this.core.closed || this.#parked || this.#abort) {
      return
    }
    if (this.#restingOnDeferred()) {
      this.core.setStatus('parked')
    }
  }

  #restingOnDeferred(): boolean {
    if (this.#pendingToolCalls.size === 0) {
      return false
    }
    for (const call of this.#pendingToolCalls.values()) {
      if (call.parkable !== true) {
        return false
      }
    }
    return true
  }

  #applyExecutionResult(executionId: string, result: ToolExecutionResult): void {
    // A parked instance is not the session any more: its rehydrated successor owns the pending
    // call, and applying here would write into a discarded history.
    if (this.core.closed || this.#parked) {
      return
    }
    this.#dispatched.delete(executionId)
    if (result.status === 'ok') {
      this.core.emit({
        type: 'execution_result',
        executionId,
        output: { type: 'json', value: result.output },
        logs: result.logs,
      })
      this.resolveToolCall(executionId, { type: 'json', value: result.output })
      return
    }
    this.core.emit({
      type: 'execution_failed',
      executionId,
      reason: result.reason,
      error: result.error,
      logs: result.logs,
    })
    this.resolveToolCall(executionId, { type: 'text', value: `${result.reason}: ${result.error}` }, { isError: true })
  }

  async #runTurn(): Promise<void> {
    if (this.core.closed || this.#parked || this.#pendingToolCalls.size > 0) {
      return
    }
    if (this.#messages.at(-1)?.role === 'assistant') {
      return
    }
    this.core.setStatus('running')
    const agent = new ToolLoopAgent({
      model: this.#model,
      tools: this.config.tools ?? {},
      instructions: this.#instructions,
      stopWhen: isStepCount(this.config.maxSteps ?? 20),
    })
    const abort = new AbortController()
    this.#abort = abort
    const accum = (this.#turnAccum ??= newTurnUsage())
    const stream = new TurnStream({
      emit: (body) => {
        this.core.emit(body)
      },
      model: () => this.#modelId(),
      partials: this.config.includePartialMessages !== false,
    })
    try {
      const result = await agent.stream({ messages: [...this.#messages], abortSignal: abort.signal })
      for await (const part of result.fullStream) {
        if (this.core.closed) {
          break
        }
        if (part.type === 'finish-step') {
          this.#contextTokens = stepContextTokens(part.usage) ?? this.#contextTokens
        }
        stream.accept(part)
      }
      stream.flush()
      if (stream.error !== undefined) {
        throw stream.error
      }
      if (abort.signal.aborted) {
        throw new Error('interrupted')
      }
      const [responseMessages, usage, toolCalls, text] = await Promise.all([
        result.responseMessages,
        result.totalUsage,
        result.toolCalls,
        result.text,
      ])
      if (this.core.closed) {
        return
      }
      addUsage(accum, usage)
      this.#settleResponse(responseMessages as ModelMessage[], toolCalls, text)
    } catch (error) {
      if (this.core.closed) {
        return
      }
      stream.flushPartial()
      this.#failTurn(accum, abort.signal.aborted ? 'interrupted' : errorMessage(error))
    } finally {
      if (this.#abort === abort) {
        this.#abort = undefined
      }
    }
  }

  #settleResponse(
    responseMessages: ModelMessage[],
    toolCalls: readonly { toolCallId: string; toolName: string; input: unknown }[],
    text: string,
  ): void {
    this.#messages.push(...responseMessages)
    const settled = settledToolCallIds(responseMessages)
    for (const call of toolCalls) {
      if (!settled.has(call.toolCallId)) {
        this.#pendingToolCalls.set(call.toolCallId, { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })
      }
    }
    if (this.#pendingToolCalls.size > 0) {
      this.#dispatchPending()
      return
    }
    this.#finishTurn(text)
  }

  #failTurn(accum: TurnUsage, error: string): void {
    this.#numTurns += 1
    this.core.emitTurnResult({
      startedAt: accum.startedAt,
      numTurns: this.#numTurns,
      totalCostUsd: 0,
      errors: [error],
      usage: wireUsage(accum),
      costs: false,
    })
    this.#turnAccum = undefined
    this.core.setStatus('idle')
  }

  #finishTurn(text: string): void {
    const accum = this.#turnAccum ?? newTurnUsage()
    this.#numTurns += 1
    this.core.emitTurnResult({
      startedAt: accum.startedAt,
      numTurns: this.#numTurns,
      totalCostUsd: 0,
      result: text,
      usage: wireUsage(accum),
      byModel: this.#turnByModel(accum),
      costs: true,
    })
    this.#turnAccum = undefined
    this.core.setStatus('idle')
  }

  protected async reportFacts(): Promise<SessionReportFacts> {
    const model = this.#model
    const vendor = providerVendor(typeof model === 'string' ? undefined : (model as { provider?: string }).provider)
    const maxTokens = resolveContextWindow(this.config.contextWindow, this.#modelId(), this.#modelAlias)
    if (this.#contextTokens === undefined) {
      return { vendor, context: undefined, rateLimits: false }
    }
    return {
      vendor,
      context: { totalTokens: this.#contextTokens, maxTokens, measured: this.core.status === 'running' ? 'live' : 'last_turn' },
      contextNote:
        maxTokens === undefined
          ? 'The context window size of this model is unknown to the gateway; the operator can set provider.contextWindow on the profile.'
          : undefined,
      rateLimits: false,
    }
  }

  #modelId(): string | undefined {
    const model = this.#model
    if (typeof model === 'string') {
      return model
    }
    return (model as { modelId?: string }).modelId
  }

  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    return (await this.config.reportMcpServers?.()) ?? []
  }

  #emitToolTitles(): void {
    const titles = this.config.toolTitles
    if (titles && Object.keys(titles).length > 0) {
      this.core.emit({ type: 'tool_titles', titles })
    }
  }
}

function assertPermissionMode(mode: PermissionMode): void {
  if (!supportsPermissionMode('provider', mode)) {
    throw new Error(`permission mode '${mode}' is not supported by the AI SDK engine`)
  }
}

function textValue(output: ToolCallOutput): string {
  return output.type === 'text' ? output.value : JSON.stringify(output.value)
}

function callsTool(part: { type: string }, toolCallId: string): part is ToolCallPart {
  return part.type === 'tool-call' && (part as ToolCallPart).toolCallId === toolCallId
}
