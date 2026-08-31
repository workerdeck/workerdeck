import { randomUUID } from 'node:crypto'
import { ToolLoopAgent, generateText, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import {
  ENGINE_CAPABILITIES,
  snapshotRetains,
  type ContentBlock,
  type CreateSessionRequest,
  type McpServerStatusInfo,
  type PermissionDecisionSource,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
  type ToolExecutionBackend,
} from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import { type AttachmentInput, attachmentRef, normalizeMediaType } from '../../lib/attachments.ts'
import type { ParkedExecution, PermissionDecision, Runner, RunnerSnapshot, SessionEventListener } from '../../runner-interface.ts'
import type { ToolExecutionCall, ToolExecutionResult, ToolExecutor } from '../../executors/tool-executor.ts'
import { EventLog } from '../../lib/event-log.ts'
import { SubscriberSet, type SubscribeOptions } from '../../lib/subscribers.ts'
import { sessionTitle, withTitle } from '../../lib/title.ts'

const SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'bypassPermissions', 'dontAsk']

export type AiSdkRunnerConfig = Omit<CreateSessionRequest, 'cwd'> & {
  cwd?: string
  languageModel: LanguageModel
  tools?: ToolSet
  instructions?: string
  maxSteps?: number
  executor?: ToolExecutor
  executableTools?: string[]
  vfs?: SandboxVfs
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  executionBackend?: ToolExecutionBackend
  shouldApprove?: (call: { toolName: string; input: unknown }) => boolean
  approvalTimeoutMs?: number
  resolveModel?: (modelId: string | undefined) => LanguageModel
  reportMcpServers?: () => Promise<McpServerStatusInfo[] | undefined>
  onClose?: () => void | Promise<void>
  restore?: RunnerSnapshot
}

export type PendingToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
  deferred?: boolean
  expiresAt?: number
}

export type AiSdkSessionState = {
  messages: ModelMessage[]
  pendingToolCalls: PendingToolCall[]
  dispatched: string[]
  numTurns: number
  totalUsage: { input: number; output: number; cacheWrite: number; cacheRead: number }
  turnAccum?: { startedAt: number; input: number; output: number; cacheWrite: number; cacheRead: number }
  permissionMode: PermissionMode
  model?: string
  lastActivityAt?: number
  parkedAt?: number
}

export type ToolCallOutput = { type: 'text'; value: string } | { type: 'json'; value: unknown }

export class AiSdkRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: AiSdkRunnerConfig
  #model: LanguageModel
  #log = new EventLog()
  #subscribers = new SubscriberSet()
  #status: SessionStatus = 'starting'
  #statusDetail: string | undefined
  #permissionMode: PermissionMode
  #messages: ModelMessage[] = []
  #pendingToolCalls = new Map<string, PendingToolCall>()
  #dispatched = new Set<string>()
  #turnChain: Promise<void> = Promise.resolve()
  #abort: AbortController | undefined
  #turnAccum: { startedAt: number; input: number; output: number; cacheWrite: number; cacheRead: number } | undefined
  #numTurns = 0
  #totalUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  #started = false
  #closed = false
  #parked = false
  #modelAlias: string | undefined
  #pendingApprovals = new Map<
    string,
    {
      request: PermissionRequest
      toolCallId: string
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(config: AiSdkRunnerConfig, id: string = randomUUID()) {
    const mode = config.permissionMode ?? 'default'
    if (!SUPPORTED_PERMISSION_MODES.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the AI SDK engine`)
    }
    this.#config = config
    this.#model = config.languageModel
    this.#permissionMode = mode
    this.#modelAlias = config.model
    this.id = config.restore?.id ?? id
    this.createdAt = config.restore?.createdAt ?? Date.now()
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
    this.#log.restore(snapshot.events, snapshot.seq, state.lastActivityAt)
    this.#messages = [...state.messages]
    for (const call of state.pendingToolCalls) {
      this.#pendingToolCalls.set(call.toolCallId, call)
    }
    this.#dispatched = new Set(state.dispatched)
    this.#numTurns = state.numTurns
    this.#totalUsage = { ...state.totalUsage }
    this.#turnAccum = state.turnAccum ? { ...state.turnAccum } : undefined
    if (this.#turnAccum && state.parkedAt !== undefined) {
      this.#turnAccum.startedAt += Date.now() - state.parkedAt
    }
    this.#permissionMode = state.permissionMode
    this.#status = this.#pendingToolCalls.size > 0 ? 'parked' : 'idle'
    if (state.model !== undefined && state.model !== this.#modelAlias && this.#config.resolveModel) {
      this.#modelAlias = state.model
      this.#model = this.#config.resolveModel(state.model)
    }
  }

  get status(): SessionStatus {
    return this.#status
  }

  get lastSeq(): number {
    return this.#log.seq
  }

  get messages(): ModelMessage[] {
    return [...this.#messages]
  }

  get pendingToolCalls(): PendingToolCall[] {
    return [...this.#pendingToolCalls.values()]
  }

  get pendingApprovals(): PermissionRequest[] {
    return [...this.#pendingApprovals.values()].map((a) => a.request)
  }

  get vfs(): SandboxVfs | undefined {
    return this.#config.vfs
  }

  info(): SessionInfo {
    return {
      id: this.id,
      status: this.#status,
      // Never process.cwd(): this engine opens no directory, and the gateway's own deploy path
      // has no business on a client surface.
      cwd: this.#config.cwd ?? '',
      profile: this.#config.profile,
      engine: 'provider',
      capabilities: this.#config.shouldApprove
        ? { ...ENGINE_CAPABILITIES.provider, interactiveApprovals: true }
        : ENGINE_CAPABILITIES.provider,
      model: this.#modelId(),
      permissionMode: this.#permissionMode,
      createdAt: this.createdAt,
      lastSeq: this.#log.seq,
      activityCount: this.#log.activityCount,
      contextUsage: this.#log.contextUsage,
      pendingPermissionCount: this.#pendingApprovals.size,
      meta: this.#config.meta,
      scope: this.#config.scope,
      title: sessionTitle(this.#config),
      numTurns: this.#numTurns || undefined,
      lastActivityAt: this.#log.lastActivityAt,
    }
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#turnChain
    }
    this.#started = true
    if (this.#config.restore) {
      return this.#turnChain
    }
    this.#setStatus('idle')
    if (this.#config.prompt) {
      this.sendMessage(this.#config.prompt)
    }
    return this.#turnChain
  }

  park(): RunnerSnapshot | undefined {
    if (this.#closed || this.#parked) {
      return undefined
    }
    if (this.#abort || !this.#restingOnDeferred()) {
      return undefined
    }
    this.#setStatus('parked')
    const snapshot = this.#buildSnapshot()
    this.#parked = true
    this.#subscribers.clear()
    try {
      void Promise.resolve(this.#config.onClose?.()).catch(() => {})
    } catch {}
    return snapshot
  }

  snapshot(): RunnerSnapshot | undefined {
    if (this.#closed || this.#parked || this.#abort) {
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
    const state: AiSdkSessionState = {
      messages: this.#messages,
      pendingToolCalls: [...this.#pendingToolCalls.values()],
      dispatched: [...this.#dispatched],
      numTurns: this.#numTurns,
      totalUsage: { ...this.#totalUsage },
      turnAccum: this.#turnAccum ? { ...this.#turnAccum } : undefined,
      permissionMode: this.#permissionMode,
      model: this.#modelAlias,
      lastActivityAt: this.#log.lastActivityAt,
      parkedAt: Date.now(),
    }
    return {
      engine: 'provider',
      id: this.id,
      createdAt: this.createdAt,
      seq: this.#log.seq,
      events: this.#log.events.filter((event) => snapshotRetains(event)),
      vfs: this.#config.vfs?.snapshot(),
      parked,
      state,
    }
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#parked) {
      throw new Error('session is parked')
    }
    if (this.#closed) {
      throw new Error('session is closed')
    }
    const content = attachments?.length
      ? [
          ...attachments.map((attachment) => ({
            type: 'file' as const,
            data: attachment.data,
            mediaType: normalizeMediaType(attachment.mediaType),
            filename: attachment.name,
          })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text
    this.#messages.push({ role: 'user', content })
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid: randomUUID(),
    })
    this.#scheduleTurn()
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
    if (!pending || this.#closed || this.#parked) {
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
    this.#emit({
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

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const approval = this.#pendingApprovals.get(requestId)
    if (!approval) {
      return false
    }
    clearTimeout(approval.timer)
    this.#pendingApprovals.delete(requestId)
    const source: PermissionDecisionSource = 'client'
    if (decision.behavior === 'allow') {
      this.#emit({
        type: 'permission_resolved',
        requestId,
        behavior: 'allow',
        resolvedBy: source,
      })
      this.#dispatchSingle(approval.toolCallId)
    } else {
      const message = decision.message ?? 'Permission denied by user'
      this.#emit({
        type: 'permission_resolved',
        requestId,
        behavior: 'deny',
        resolvedBy: source,
        message,
      })
      this.#applyExecutionResult(approval.toolCallId, {
        status: 'failed',
        reason: 'permission_denied',
        error: message,
      })
      if (decision.interrupt) {
        void this.interrupt()
      }
    }
    return true
  }

  emitFileDelivered(file: { path: string; bytes: number; description?: string }): void {
    if (this.#closed || this.#parked) {
      return
    }
    this.#emit({ type: 'file_delivered', ...file })
  }

  async generateDigest(prompt: string): Promise<string> {
    const result = await generateText({
      model: this.#model,
      prompt,
      abortSignal: this.#abort?.signal,
    })
    const accum = this.#turnAccum
    if (accum) {
      accum.input += result.usage.inputTokens ?? 0
      accum.output += result.usage.outputTokens ?? 0
      accum.cacheWrite += result.usage.inputTokenDetails?.cacheWriteTokens ?? 0
      accum.cacheRead += result.usage.inputTokenDetails?.cacheReadTokens ?? 0
    }
    return result.text
  }

  async clearContext(): Promise<void> {
    if (this.#status === 'closed' || this.#status === 'failed') {
      throw new Error('session is closed')
    }
    const run = this.#turnChain.then(() => {
      if (this.#closed) {
        throw new Error('session is closed')
      }
      // Waiting cannot resolve parked external work — a bridged result is owed by a client that
      // may answer in two days, and the messages it splices into are what a clear would drop.
      if (this.#pendingToolCalls.size > 0) {
        throw new Error('cannot clear context while tool calls are outstanding')
      }
      this.#messages = []
      this.#emit({ type: 'conversation_reset' })
    })
    this.#turnChain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  async interrupt(): Promise<void> {
    if (this.#abort) {
      this.#abort.abort()
    } else if (this.#pendingToolCalls.size > 0) {
      const accum = this.#turnAccum ?? { startedAt: Date.now(), input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
      for (const call of Array.from(this.#pendingToolCalls.values())) {
        this.#settlePendingCall(call.toolCallId, { type: 'text', value: 'interrupted' }, true)
      }
      this.#dispatched.clear()
      this.#numTurns += 1
      this.#emit({
        type: 'turn_result',
        subtype: 'error_during_execution',
        isError: true,
        durationMs: Date.now() - accum.startedAt,
        numTurns: this.#numTurns,
        totalCostUsd: 0,
        errors: ['interrupted'],
        usage: turnUsage(accum),
      })
      this.#turnAccum = undefined
      this.#setStatus('idle')
    }
    await this.#turnChain
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!SUPPORTED_PERMISSION_MODES.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the AI SDK engine`)
    }
    this.#permissionMode = mode
    this.#emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    const resolve = this.#config.resolveModel
    if (!resolve) {
      throw new Error('set_model is not supported by this session')
    }
    this.#model = resolve(model)
    this.#modelAlias = model
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
    if (this.#closed || this.#parked) {
      return
    }
    this.#closed = true
    this.#abort?.abort()
    this.#pendingToolCalls.clear()
    this.#dispatched.clear()
    for (const { timer } of this.#pendingApprovals.values()) {
      clearTimeout(timer)
    }
    this.#pendingApprovals.clear()
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
    try {
      void Promise.resolve(this.#config.onClose?.()).catch(() => {})
    } catch {}
  }

  eventAt(seq: number): SessionEvent | undefined {
    return this.#log.at(seq)
  }

  subscribe(listener: SessionEventListener, afterSeq = 0, options?: SubscribeOptions): () => void {
    return this.#subscribers.subscribe(this.#log.events, listener, afterSeq, options, this.#log.resetSeq)
  }

  #scheduleTurn(): void {
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  settleExecution(executionId: string, result: ToolExecutionResult): boolean {
    if (this.#closed || this.#parked) {
      return false
    }
    if (!this.#pendingToolCalls.has(executionId)) {
      return false
    }
    this.#applyExecutionResult(executionId, result)
    return true
  }

  #dispatchPending(): void {
    const executor = this.#config.executor
    if (!executor) {
      return
    }
    const executable = this.#config.executableTools
    const needsApproval = this.#permissionMode === 'default' && this.#config.shouldApprove
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
        if ([...this.#pendingApprovals.values()].some((a) => a.toolCallId === call.toolCallId)) {
          anyAwaiting = true
          continue
        }
        const requestId = randomUUID()
        const timeoutMs = this.#config.approvalTimeoutMs ?? 120_000
        const request: PermissionRequest = {
          id: requestId,
          toolName: call.toolName,
          input: call.input as Record<string, unknown>,
          toolUseId: call.toolCallId,
          title: `Agent wants to run ${call.toolName}`,
          displayName: call.toolName,
          expiresAt: Date.now() + timeoutMs,
        }
        const timer = setTimeout(() => {
          if (!this.#pendingApprovals.has(requestId)) {
            return
          }
          this.resolvePermission(requestId, {
            behavior: 'deny',
            message: 'Approval timed out',
          })
        }, timeoutMs)
        this.#pendingApprovals.set(requestId, { request, toolCallId: call.toolCallId, timer })
        this.#emit({ type: 'permission_requested', request })
        anyAwaiting = true
        continue
      }
      this.#dispatched.add(call.toolCallId)
      const dispatched = this.#dispatchCall(executor, call)
      anyDeferred ||= dispatched.deferred
      inFlight.push(dispatched.promise)
    }
    if (anyAwaiting) {
      this.#setStatus('awaiting_approval')
    }
    if (anyDeferred) {
      void Promise.allSettled(inFlight).then(() => this.#announceParked())
    }
  }

  #dispatchSingle(toolCallId: string): void {
    const executor = this.#config.executor
    if (!executor) {
      return
    }
    const call = this.#pendingToolCalls.get(toolCallId)
    if (!call || this.#dispatched.has(toolCallId)) {
      return
    }
    this.#dispatched.add(toolCallId)
    const dispatched = this.#dispatchCall(executor, call)
    if (dispatched.deferred) {
      void dispatched.promise.then(() => this.#announceParked())
    }
  }

  #dispatchCall(executor: ToolExecutor, call: PendingToolCall): { deferred: boolean; promise: Promise<void> } {
    const toolCall: ToolExecutionCall = {
      executionId: call.toolCallId,
      sessionId: this.id,
      tool: call.toolName,
      input: call.input,
      vfs: this.#config.vfs,
      limits: this.#config.executionLimits,
      signal: this.#abort?.signal,
    }
    const profile = executor.describe?.(toolCall) ?? {}
    call.deferred = profile.deferred === true ? true : undefined
    call.expiresAt = profile.timeoutMs === undefined ? undefined : Date.now() + profile.timeoutMs
    this.#emit({
      type: 'execution_dispatched',
      executionId: call.toolCallId,
      toolName: call.toolName,
      backend: profile.backend ?? this.#config.executionBackend ?? 'server',
      deferred: call.deferred,
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
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return { deferred: call.deferred === true, promise }
  }

  #announceParked(): void {
    if (this.#closed || this.#parked || this.#abort) {
      return
    }
    if (this.#restingOnDeferred()) {
      this.#setStatus('parked')
    }
  }

  #restingOnDeferred(): boolean {
    if (this.#pendingToolCalls.size === 0) {
      return false
    }
    for (const call of this.#pendingToolCalls.values()) {
      if (call.deferred !== true) {
        return false
      }
    }
    return true
  }

  #applyExecutionResult(executionId: string, result: ToolExecutionResult): void {
    // A parked instance is not the session any more: its rehydrated successor owns the pending
    // call, and applying here would write into a discarded history.
    if (this.#closed || this.#parked) {
      return
    }
    this.#dispatched.delete(executionId)
    if (result.status === 'ok') {
      this.#emit({
        type: 'execution_result',
        executionId,
        output: { type: 'json', value: result.output },
        logs: result.logs,
      })
      this.resolveToolCall(executionId, { type: 'json', value: result.output })
      return
    }
    this.#emit({
      type: 'execution_failed',
      executionId,
      reason: result.reason,
      error: result.error,
      logs: result.logs,
    })
    this.resolveToolCall(executionId, { type: 'text', value: `${result.reason}: ${result.error}` }, { isError: true })
  }

  async #runTurn(): Promise<void> {
    if (this.#closed || this.#parked || this.#pendingToolCalls.size > 0) {
      return
    }
    if (this.#messages.at(-1)?.role === 'assistant') {
      return
    }
    this.#setStatus('running')
    const agent = new ToolLoopAgent({
      model: this.#model,
      tools: this.#config.tools ?? {},
      instructions: this.#config.instructions,
      stopWhen: isStepCount(this.#config.maxSteps ?? 20),
    })
    const abort = new AbortController()
    this.#abort = abort
    const accum = (this.#turnAccum ??= {
      startedAt: Date.now(),
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    })
    let blocks: ContentBlock[] = []
    const textBuf = new Map<string, string>()
    const reasoningBuf = new Map<string, string>()
    const flush = (): void => {
      if (blocks.length === 0) {
        return
      }
      this.#emit({
        type: 'assistant_message',
        message: { role: 'assistant', content: blocks, model: this.#modelId() },
        parentToolUseId: null,
        uuid: randomUUID(),
      })
      blocks = []
    }
    try {
      const result = await agent.stream({
        messages: [...this.#messages],
        abortSignal: abort.signal,
      })
      const partials = this.#config.includePartialMessages !== false
      const emitToolResult = (toolCallId: string, content: string, isError?: boolean): void => {
        flush()
        this.#emit({
          type: 'user_message',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCallId, content, is_error: isError }],
          },
          parentToolUseId: null,
          synthetic: true,
          uuid: randomUUID(),
        })
      }
      let streamError: unknown
      for await (const part of result.fullStream) {
        if (this.#closed) {
          break
        }
        switch (part.type) {
          case 'text-delta': {
            textBuf.set(part.id, (textBuf.get(part.id) ?? '') + part.text)
            if (partials) {
              this.#emit({
                type: 'stream_delta',
                event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part.text } },
                parentToolUseId: null,
                uuid: randomUUID(),
              })
            }
            break
          }
          case 'text-end': {
            const text = textBuf.get(part.id)
            textBuf.delete(part.id)
            if (text) {
              blocks.push({ type: 'text', text })
            }
            break
          }
          case 'reasoning-delta': {
            reasoningBuf.set(part.id, (reasoningBuf.get(part.id) ?? '') + part.text)
            if (partials) {
              this.#emit({
                type: 'stream_delta',
                event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: part.text } },
                parentToolUseId: null,
                uuid: randomUUID(),
              })
            }
            break
          }
          case 'reasoning-end': {
            const thinking = reasoningBuf.get(part.id)
            reasoningBuf.delete(part.id)
            if (thinking) {
              blocks.push({ type: 'thinking', thinking })
            }
            break
          }
          case 'tool-call': {
            blocks.push({
              type: 'tool_use',
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            })
            flush()
            break
          }
          case 'tool-result': {
            emitToolResult(part.toolCallId, typeof part.output === 'string' ? part.output : JSON.stringify(part.output))
            break
          }
          case 'tool-error': {
            emitToolResult(part.toolCallId, errorText(part.error), true)
            break
          }
          case 'finish-step': {
            flush()
            break
          }
          case 'error': {
            streamError ??= part.error
            break
          }
          default: {
            break
          }
        }
      }
      flush()
      if (streamError !== undefined) {
        throw streamError
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
      if (this.#closed) {
        return
      }
      accum.input += usage.inputTokens ?? 0
      accum.output += usage.outputTokens ?? 0
      accum.cacheWrite += usage.inputTokenDetails?.cacheWriteTokens ?? 0
      accum.cacheRead += usage.inputTokenDetails?.cacheReadTokens ?? 0
      this.#messages.push(...(responseMessages as ModelMessage[]))
      const settled = new Set<string>()
      for (const message of responseMessages as ModelMessage[]) {
        if (message.role !== 'tool' || !Array.isArray(message.content)) {
          continue
        }
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            settled.add(part.toolCallId)
          }
        }
      }
      for (const call of toolCalls) {
        if (settled.has(call.toolCallId)) {
          continue
        }
        this.#pendingToolCalls.set(call.toolCallId, {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })
      }
      if (this.#pendingToolCalls.size > 0) {
        this.#dispatchPending()
        return
      }
      this.#finishTurn(text)
    } catch (error) {
      if (this.#closed) {
        return
      }
      for (const [, thinking] of reasoningBuf) {
        if (thinking) {
          blocks.push({ type: 'thinking', thinking })
        }
      }
      for (const [, text] of textBuf) {
        if (text) {
          blocks.push({ type: 'text', text })
        }
      }
      flush()
      const message = error instanceof Error ? error.message : String(error)
      this.#numTurns += 1
      this.#emit({
        type: 'turn_result',
        subtype: 'error_during_execution',
        isError: true,
        durationMs: Date.now() - accum.startedAt,
        numTurns: this.#numTurns,
        totalCostUsd: 0,
        errors: [abort.signal.aborted ? 'interrupted' : message],
        usage: turnUsage(accum),
      })
      this.#turnAccum = undefined
      this.#setStatus('idle')
    } finally {
      if (this.#abort === abort) {
        this.#abort = undefined
      }
    }
  }

  #finishTurn(text: string): void {
    const accum = this.#turnAccum ?? { startedAt: Date.now(), input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    this.#numTurns += 1
    this.#totalUsage.input += accum.input
    this.#totalUsage.output += accum.output
    this.#totalUsage.cacheWrite += accum.cacheWrite
    this.#totalUsage.cacheRead += accum.cacheRead
    this.#emit({
      type: 'turn_result',
      subtype: 'success',
      isError: false,
      durationMs: Date.now() - accum.startedAt,
      numTurns: this.#numTurns,
      totalCostUsd: 0,
      result: text,
      usage: turnUsage(accum),
    })
    this.#turnAccum = undefined
    this.#setStatus('idle')
  }

  #modelId(): string | undefined {
    const model = this.#model
    if (typeof model === 'string') {
      return model
    }
    return (model as { modelId?: string }).modelId
  }

  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    return (await this.#config.reportMcpServers?.()) ?? []
  }

  setTitle(title: string | undefined): void {
    this.#config = withTitle(this.#config, title)
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    // Deduped on the (status, detail) pair: deduping on status alone would swallow a new detail
    // for an unchanged status, which is the one update a detail exists to carry.
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
    this.#subscribers.emit(this.#log.append(body))
  }
}

const turnUsage = (accum: { input: number; output: number; cacheWrite: number; cacheRead: number }) => {
  return {
    input_tokens: accum.input,
    output_tokens: accum.output,
    cache_creation_input_tokens: accum.cacheWrite,
    cache_read_input_tokens: accum.cacheRead,
  }
}

const textValue = (output: ToolCallOutput): string => {
  return output.type === 'text' ? output.value : JSON.stringify(output.value)
}

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}
