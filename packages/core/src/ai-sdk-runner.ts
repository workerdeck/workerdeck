import { randomUUID } from 'node:crypto'
import {
  ToolLoopAgent,
  generateText,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type {
  ContentBlock,
  CreateSessionRequest,
  PermissionMode,
  PermissionRequest,
  SessionEvent,
  SessionEventBody,
  SessionInfo,
  SessionStatus,
  ToolExecutionBackend,
} from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import { type AttachmentInput, attachmentRef, normalizeMediaType } from './attachments.ts'
import type {
  ParkedExecution,
  PermissionDecision,
  Runner,
  RunnerSnapshot,
  SessionEventListener,
} from './runner-interface.ts'
import type { ToolExecutionCall, ToolExecutionResult, ToolExecutor } from './tool-executor.ts'

/** Permission modes this engine can honor. The rest of the protocol vocabulary
 * (acceptEdits/plan/auto) is Claude Code CLI semantics with no meaning here —
 * setPermissionMode rejects them, which the server surfaces as protocol_error. */
const SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'bypassPermissions', 'dontAsk']

/** `cwd` is optional for this engine: the loop has no host-filesystem coupling
 * (tools get scoped VFS handles instead). Defaults to process.cwd() for display. */
export type AiSdkRunnerConfig = Omit<CreateSessionRequest, 'cwd'> & {
  cwd?: string
  /** AI SDK language model instance (or gateway model id string). Provider
   * resolution from profiles happens host-side; core takes the resolved model. */
  languageModel: LanguageModel
  /** Tools available to the loop. Tools WITHOUT `execute` halt the loop when
   * called; their calls surface via `pendingToolCalls` and are answered with
   * `resolveToolCall()`, which re-enters the loop by message-state replay. */
  tools?: ToolSet
  /** System prompt (AI SDK v7 `instructions`). */
  instructions?: string
  /** Max loop steps per turn. Default 20. */
  maxSteps?: number
  /**
   * Executes tool calls the loop cannot run inline (tools declared without
   * `execute`). With one set, the runner drives the whole cycle itself:
   * dispatch on park, apply the result, re-enter. Without one, parked calls
   * stay on {@link pendingToolCalls} for the host to answer via
   * {@link resolveToolCall}.
   */
  executor?: ToolExecutor
  /** Names the executor handles. Others stay pending for the host. */
  executableTools?: string[]
  /** Scratch filesystem handed to sandboxed executions. */
  vfs?: SandboxVfs
  /** Per-execution limits passed to the executor. */
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /** Which backend the executor represents, for `execution_dispatched` events. */
  executionBackend?: ToolExecutionBackend
  /** Swap models mid-session (`set_model`). Unset = setModel() is rejected. */
  resolveModel?: (modelId: string | undefined) => LanguageModel
  /** Called once when the session closes — release per-session resources the
   * host attached (an MCP connection, a watcher). Errors are swallowed. Also
   * runs when the session parks: parking releases the same resources. */
  onClose?: () => void | Promise<void>
  /**
   * Rebuild a parked session from {@link AiSdkRunner.park}'s snapshot instead of
   * starting a fresh one: the id, event log, seq counter, message history, and
   * the executions it parked on are all adopted. The rest of the config is the
   * live wiring (model, tools, executor, VFS) and is taken as given — a
   * rehydrated session may legitimately come up against a re-created tool set.
   */
  restore?: RunnerSnapshot
}

/** An external (execute-less) tool call the loop is parked on. */
export type PendingToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
  /** True when the executor declared the execution deferred — the session may
   * park on it, and only a host-delivered result can settle it. */
  deferred?: boolean
  /** Epoch ms the host's execution watchdog should fire at. */
  expiresAt?: number
}

/** The provider engine's half of a {@link RunnerSnapshot} — its continuation
 * state. Opaque to the host; only this class reads it. */
export type AiSdkSessionState = {
  messages: ModelMessage[]
  pendingToolCalls: PendingToolCall[]
  /** Calls already handed to an executor, so rehydration never re-dispatches them. */
  dispatched: string[]
  numTurns: number
  totalUsage: { input: number; output: number; cacheWrite: number; cacheRead: number }
  /** The in-progress turn's accumulator: a parked turn's earlier legs still owe
   * their tokens and elapsed time to the turn_result that eventually lands. */
  turnAccum?: { startedAt: number; input: number; output: number; cacheWrite: number; cacheRead: number }
  permissionMode: PermissionMode
  /** Model alias last requested (config.model or a set_model), NOT the resolved
   * provider model id — re-resolution goes back through `resolveModel`. */
  model?: string
  lastActivityAt?: number
  /** When the snapshot was taken, so a rehydrated turn can discount the time it
   * spent parked instead of billing it as elapsed turn duration. */
  parkedAt?: number
}

export type ToolCallOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }

/**
 * Model-agnostic runner over the AI SDK v7 ToolLoopAgent. The session's durable
 * state is its ModelMessage history: every turn — including continuation after an
 * externally-executed tool call — is a fresh streamed call over that history
 * (message-state replay; the loop cannot be suspended). Output is emitted as it
 * happens: `stream_delta` per token (unless includePartialMessages is false) and
 * assistant/tool messages per step. Emits the same seq-numbered SessionEvent log
 * as SessionRunner; engine-specific CLI telemetry (system_init, capabilities,
 * rate_limit, ...) is simply never emitted.
 */
export class AiSdkRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: AiSdkRunnerConfig
  #model: LanguageModel
  #events: SessionEvent[] = []
  #listeners = new Set<SessionEventListener>()
  #seq = 0
  #status: SessionStatus = 'starting'
  #permissionMode: PermissionMode
  #messages: ModelMessage[] = []
  #pendingToolCalls = new Map<string, PendingToolCall>()
  /** Calls already handed to the executor, so a re-park never double-dispatches. */
  #dispatched = new Set<string>()
  #turnChain: Promise<void> = Promise.resolve()
  #abort: AbortController | undefined
  /** Accumulates across every leg of one turn. A turn that parks on external
   * tool calls spans several generate() calls; usage and elapsed time must
   * cover all of them, not just the leg that happens to finish. */
  #turnAccum: { startedAt: number; input: number; output: number; cacheWrite: number; cacheRead: number } | undefined
  #numTurns = 0
  #totalUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  #lastActivityAt: number | undefined
  #started = false
  #closed = false
  /** Parked: state has been snapshotted and this instance is inert. Not closed —
   * the session lives on in the snapshot and resumes as a new instance. */
  #parked = false
  /** Model alias as requested (not the resolved provider id) — what set_model was
   * given, so a rehydrated session can re-resolve the same choice. */
  #modelAlias: string | undefined

  constructor(config: AiSdkRunnerConfig, id: string = randomUUID()) {
    const mode = config.permissionMode ?? 'default'
    if (!SUPPORTED_PERMISSION_MODES.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the AI SDK engine`)
    }
    this.#config = config
    this.#model = config.languageModel
    this.#permissionMode = mode
    this.#modelAlias = config.model
    // A rehydrated session keeps its identity: same id, same age, same event log.
    this.id = config.restore?.id ?? id
    this.createdAt = config.restore?.createdAt ?? Date.now()
    if (config.restore) this.#restore(config.restore)
  }

  /** Adopt a parked session's state. The event log and seq counter come back
   * verbatim: a client reattaching with `afterSeq` must see one unbroken stream
   * across the teardown, not a second session that restarts at 1. */
  #restore(snapshot: RunnerSnapshot): void {
    if (snapshot.engine !== 'provider') {
      throw new Error(`cannot restore a '${snapshot.engine}' snapshot into the AI SDK engine`)
    }
    const state = snapshot.state as AiSdkSessionState | undefined
    if (!state || !Array.isArray(state.messages)) {
      throw new Error('session snapshot is missing its provider-engine state')
    }
    this.#seq = snapshot.seq
    this.#events = [...snapshot.events]
    this.#messages = [...state.messages]
    for (const call of state.pendingToolCalls) this.#pendingToolCalls.set(call.toolCallId, call)
    // Already handed to a backend before the teardown: re-dispatching would run
    // the work twice (and a deferred backend can only ever answer once).
    this.#dispatched = new Set(state.dispatched)
    this.#numTurns = state.numTurns
    this.#totalUsage = { ...state.totalUsage }
    this.#turnAccum = state.turnAccum ? { ...state.turnAccum } : undefined
    if (this.#turnAccum && state.parkedAt !== undefined) {
      // The turn's clock stops while parked: a run that waited two days for a
      // remote result did not take two days of turn time.
      this.#turnAccum.startedAt += Date.now() - state.parkedAt
    }
    this.#permissionMode = state.permissionMode
    this.#lastActivityAt = state.lastActivityAt
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
    return this.#seq
  }

  /** The session's durable state — persist to park, replay to rehydrate. */
  get messages(): ModelMessage[] {
    return [...this.#messages]
  }

  /** External tool calls the loop is currently parked on. */
  get pendingToolCalls(): PendingToolCall[] {
    return [...this.#pendingToolCalls.values()]
  }

  get pendingApprovals(): PermissionRequest[] {
    return []
  }

  /** The session's scratch filesystem (see Runner.vfs) — the server's file
   * routes serve deliverables straight from it. */
  get vfs(): SandboxVfs | undefined {
    return this.#config.vfs
  }

  info(): SessionInfo {
    return {
      id: this.id,
      status: this.#status,
      cwd: this.#config.cwd ?? process.cwd(),
      profile: this.#config.profile,
      engine: 'provider',
      model: this.#modelId(),
      permissionMode: this.#permissionMode,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      meta: this.#config.meta,
      title: this.#title(),
      numTurns: this.#numTurns || undefined,
      lastActivityAt: this.#lastActivityAt,
    }
  }

  start(): Promise<void> {
    if (this.#started) return this.#turnChain
    this.#started = true
    if (this.#config.restore) {
      // Rehydrated mid-task: the prompt was consumed by the original run, and the
      // history is already a turn in progress. Waiting on its parked executions is
      // the whole point — the loop re-enters when one is settled.
      if (this.#pendingToolCalls.size === 0) this.#scheduleTurn()
      return this.#turnChain
    }
    this.#setStatus('idle')
    if (this.#config.prompt) this.sendMessage(this.#config.prompt)
    return this.#turnChain
  }

  /**
   * Snapshot durable state, release engine resources, and go inert — the session
   * continues in the snapshot, not in this object. Returns undefined when parking
   * would lose work or has nothing to wait for: a turn in flight, no parked call,
   * or an already-closed/parked runner.
   */
  park(): RunnerSnapshot | undefined {
    if (this.#closed || this.#parked) return undefined
    // A generate() in flight cannot be snapshotted — its messages are not in the
    // history yet. Parking is only ever correct once the loop has come to rest on
    // external calls, which is exactly when #abort has been cleared.
    if (this.#abort || !this.#restingOnDeferred()) return undefined
    // Emitted before the snapshot so the persisted log carries the transition and
    // still-attached listeners see it.
    this.#setStatus('parked')
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
      lastActivityAt: this.#lastActivityAt,
      parkedAt: Date.now(),
    }
    const snapshot: RunnerSnapshot = {
      engine: 'provider',
      id: this.id,
      createdAt: this.createdAt,
      seq: this.#seq,
      events: [...this.#events],
      vfs: this.#config.vfs?.snapshot(),
      parked,
      state,
    }
    this.#parked = true
    this.#listeners.clear()
    try {
      void Promise.resolve(this.#config.onClose?.()).catch(() => {})
    } catch {
      // Disposer errors must not break the park — the snapshot is already taken.
    }
    return snapshot
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#parked) throw new Error('session is parked')
    if (this.#closed) throw new Error('session is closed')
    // AI SDK v7 has one part type for attached bytes: `file`, with the media type
    // telling the provider what it is. Parts lead, text follows — same order the
    // Claude engine uses, for the same reason.
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

  /**
   * Deliver the result of an external (execute-less) tool call. Appends the
   * tool-result message and, once no calls remain pending, re-enters the loop.
   * Idempotent per toolCallId: unknown/already-settled ids return false.
   */
  resolveToolCall(toolCallId: string, output: ToolCallOutput, options?: { isError?: boolean }): boolean {
    if (!this.#settlePendingCall(toolCallId, output, options?.isError === true)) return false
    if (this.#pendingToolCalls.size === 0) this.#scheduleTurn()
    return true
  }

  /** Record a parked call's outcome into the message history (so it stays
   * replayable — a dangling tool call without a result is invalid input for
   * providers) and the event log. Does NOT re-enter the loop. */
  #settlePendingCall(toolCallId: string, output: ToolCallOutput, isError: boolean): boolean {
    const pending = this.#pendingToolCalls.get(toolCallId)
    if (!pending || this.#closed || this.#parked) return false
    this.#pendingToolCalls.delete(toolCallId)
    // Keep the result adjacent to the assistant message that made the call:
    // user messages typed while the turn was parked must sort AFTER the tool
    // results, or providers reject the replayed history (a tool call whose
    // result is not in the directly following message).
    let insertAt = this.#messages.length
    while (insertAt > 0 && this.#messages[insertAt - 1]!.role === 'user') insertAt--
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

  resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false
  }

  /** Emit `file_delivered` — the deliver_file tool's hand-over event (wired by
   * createEngineSession via ToolContextOptions.onFileDelivered). */
  emitFileDelivered(file: { path: string; bytes: number; description?: string }): void {
    if (this.#closed || this.#parked) return
    this.#emit({ type: 'file_delivered', ...file })
  }

  /**
   * One plain generateText over the session's current model, billed into the
   * running turn's usage accumulator — the web_fetch digest pass uses this so
   * its tokens are never lost from the turn's accounting.
   */
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

  async interrupt(): Promise<void> {
    if (this.#abort) {
      this.#abort.abort()
    } else if (this.#pendingToolCalls.size > 0) {
      // A parked turn has no generate() in flight to abort. Fail the parked
      // calls (recorded as error results so the history stays replayable) and
      // finish the turn — otherwise a park nobody answers is unrecoverable.
      const accum = this.#turnAccum ?? { startedAt: Date.now(), input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
      // Snapshot first: settling mutates the map we are iterating.
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
    if (!resolve) throw new Error('set_model is not supported by this session')
    this.#model = resolve(model)
    this.#modelAlias = model
    this.#emit({ type: 'model_changed', model })
  }

  fail(message: string): void {
    if (this.#closed) return
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    // Parked instances are already handed off — the host drops them from its
    // registry, and that must not read as the session ending.
    if (this.#closed || this.#parked) return
    this.#closed = true
    this.#abort?.abort()
    this.#pendingToolCalls.clear()
    this.#dispatched.clear()
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
    try {
      void Promise.resolve(this.#config.onClose?.()).catch(() => {})
    } catch {
      // Disposer errors must not break teardown.
    }
  }

  subscribe(listener: SessionEventListener, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) listener(event)
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #scheduleTurn(): void {
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  /**
   * Deliver the result of an execution this runner dispatched. Used by the host
   * when a backend settled out-of-band (a browser bridge answering later, a
   * deferred executor). Idempotent by executionId.
   */
  settleExecution(executionId: string, result: ToolExecutionResult): boolean {
    if (this.#closed || this.#parked) return false
    if (!this.#pendingToolCalls.has(executionId)) return false
    this.#applyExecutionResult(executionId, result)
    return true
  }

  /** Hand every parked call the executor owns to it. */
  #dispatchPending(): void {
    const executor = this.#config.executor
    if (!executor) return
    const executable = this.#config.executableTools
    const inFlight: Array<Promise<unknown>> = []
    let anyDeferred = false
    // Snapshot first: applying a result mutates the map we are iterating.
    for (const call of Array.from(this.#pendingToolCalls.values())) {
      if (executable && !executable.includes(call.toolName)) continue
      if (this.#dispatched.has(call.toolCallId)) continue
      this.#dispatched.add(call.toolCallId)
      const toolCall: ToolExecutionCall = {
        executionId: call.toolCallId,
        sessionId: this.id,
        tool: call.toolName,
        input: call.input,
        vfs: this.#config.vfs,
        limits: this.#config.executionLimits,
        signal: this.#abort?.signal,
      }
      // Per call, not per executor: a routing executor may keep one tool in
      // process and defer another, and only the deferred one may park us.
      const profile = executor.describe?.(toolCall) ?? {}
      call.deferred = profile.deferred === true ? true : undefined
      call.expiresAt = profile.timeoutMs === undefined ? undefined : Date.now() + profile.timeoutMs
      anyDeferred ||= call.deferred === true
      this.#emit({
        type: 'execution_dispatched',
        executionId: call.toolCallId,
        toolName: call.toolName,
        backend: profile.backend ?? this.#config.executionBackend ?? 'server',
        deferred: call.deferred,
        expiresAt: call.expiresAt,
      })
      inFlight.push(
        executor
          .dispatch(toolCall)
          .then((dispatch) => {
            // 'pending' means the result arrives later via settleExecution().
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
          }),
      )
    }
    // Announce the park only once every dispatch of this batch has been handed
    // over: a host that parks on the first announcement would snapshot a session
    // whose remaining calls are still being dispatched — and dispatch them into a
    // runner it had already discarded.
    if (anyDeferred) void Promise.allSettled(inFlight).then(() => this.#announceParked())
  }

  /**
   * The turn has come to rest on deferred executions: nothing is in flight, and
   * only a host-delivered result can move it. `status_changed: 'parked'` is the
   * host's cue to snapshot via {@link park} — a single, correctly-timed signal
   * rather than an inference from individual dispatch events.
   */
  #announceParked(): void {
    if (this.#closed || this.#parked || this.#abort) return
    if (this.#restingOnDeferred()) this.#setStatus('parked')
  }

  /** The loop is waiting, and everything it waits on can only be answered from
   * outside this process. One still-live in-process execution means a result is
   * coming back to THIS runner, and tearing it down would strand it. */
  #restingOnDeferred(): boolean {
    if (this.#pendingToolCalls.size === 0) return false
    for (const call of this.#pendingToolCalls.values()) {
      if (call.deferred !== true) return false
    }
    return true
  }

  /** Fold an execution's outcome back into the loop, whichever way it went. */
  #applyExecutionResult(executionId: string, result: ToolExecutionResult): void {
    // A parked instance is not the session any more: its rehydrated successor owns
    // the pending call, and applying here would write into a discarded history.
    if (this.#closed || this.#parked) return
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
    // A failed execution is ordinary tool output: the agent gets to adapt.
    this.resolveToolCall(
      executionId,
      { type: 'text', value: `${result.reason}: ${result.error}` },
      { isError: true },
    )
  }

  async #runTurn(): Promise<void> {
    if (this.#closed || this.#parked || this.#pendingToolCalls.size > 0) return
    // Nothing to respond to: the history already ends with the assistant.
    // Happens when several triggers queued turns for the same input (a message
    // typed mid-park + the park resolving) — one turn answers all of it, the
    // stragglers must not burn a generate() on an already-answered history.
    if (this.#messages.at(-1)?.role === 'assistant') return
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
    try {
      // Streamed, not generate(): a multi-step turn must reach the transcript
      // as it happens — token deltas while text is produced, each step's
      // messages the moment the step completes — not as one blob at the end.
      const result = await agent.stream({
        messages: [...this.#messages],
        abortSignal: abort.signal,
      })
      const partials = this.#config.includePartialMessages !== false
      // Completed blocks of the step in progress, flushed as an assistant
      // message at each tool call (its result may follow immediately and the
      // transcript needs the call first) and at every step boundary.
      let blocks: ContentBlock[] = []
      const textBuf = new Map<string, string>()
      const reasoningBuf = new Map<string, string>()
      const flush = (): void => {
        if (blocks.length === 0) return
        this.#emit({
          type: 'assistant_message',
          message: { role: 'assistant', content: blocks, model: this.#modelId() },
          parentToolUseId: null,
          uuid: randomUUID(),
        })
        blocks = []
      }
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
        if (this.#closed) break
        switch (part.type) {
          case 'text-delta':
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
          case 'text-end': {
            const text = textBuf.get(part.id)
            textBuf.delete(part.id)
            if (text) blocks.push({ type: 'text', text })
            break
          }
          case 'reasoning-delta':
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
          case 'reasoning-end': {
            const thinking = reasoningBuf.get(part.id)
            reasoningBuf.delete(part.id)
            if (thinking) blocks.push({ type: 'thinking', thinking })
            break
          }
          case 'tool-call':
            blocks.push({
              type: 'tool_use',
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            })
            flush()
            break
          case 'tool-result':
            emitToolResult(
              part.toolCallId,
              typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
            )
            break
          case 'tool-error':
            emitToolResult(part.toolCallId, errorText(part.error), true)
            break
          case 'finish-step':
            flush()
            break
          case 'error':
            streamError ??= part.error
            break
          default:
            break
        }
      }
      flush()
      if (streamError !== undefined) throw streamError
      if (abort.signal.aborted) throw new Error('interrupted')
      const [responseMessages, usage, toolCalls, text] = await Promise.all([
        result.responseMessages,
        result.totalUsage,
        result.toolCalls,
        result.text,
      ])
      if (this.#closed) return
      // v7's totalUsage is already cumulative across THIS call's steps — add it
      // once per leg, never per step.
      accum.input += usage.inputTokens ?? 0
      accum.output += usage.outputTokens ?? 0
      accum.cacheWrite += usage.inputTokenDetails?.cacheWriteTokens ?? 0
      accum.cacheRead += usage.inputTokenDetails?.cacheReadTokens ?? 0
      this.#messages.push(...(responseMessages as ModelMessage[]))
      // Tool calls the SDK did not execute locally (no `execute`) park the loop.
      // Settled = every call with a tool message in the response — NOT
      // `result.toolResults`, which omits errored executions (`tool-error`
      // parts). An errored call was already fed back to the model by the SDK;
      // parking on it would hang the session forever (nobody owns it).
      const settled = new Set<string>()
      for (const message of responseMessages as ModelMessage[]) {
        if (message.role !== 'tool' || !Array.isArray(message.content)) continue
        for (const part of message.content) {
          if (part.type === 'tool-result') settled.add(part.toolCallId)
        }
      }
      for (const call of toolCalls) {
        if (settled.has(call.toolCallId)) continue
        this.#pendingToolCalls.set(call.toolCallId, {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })
      }
      if (this.#pendingToolCalls.size > 0) {
        // Parked: no turn_result yet. With an executor wired in, drive the
        // executions ourselves; otherwise the host answers via resolveToolCall.
        this.#dispatchPending()
        return
      }
      this.#finishTurn(text)
    } catch (error) {
      if (this.#closed) return
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
      if (this.#abort === abort) this.#abort = undefined
    }
  }

  /** Emit the turn's result from the whole-turn accumulator, so a turn that
   * parked on external tool calls reports every leg's tokens and the full
   * elapsed time (including the time spent executing those tools). */
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
    if (typeof model === 'string') return model
    return (model as { modelId?: string }).modelId
  }

  #title(): string | undefined {
    const metaTitle = this.#config.meta?.title
    if (typeof metaTitle === 'string' && metaTitle.length > 0) return metaTitle
    const prompt = this.#config.prompt
    if (!prompt) return undefined
    return prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#status === status) return
    if (this.#status === 'closed' || this.#status === 'failed') return
    this.#status = status
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#lastActivityAt = event.ts
    this.#events.push(event)
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Listener errors must not break the runner loop.
      }
    }
  }
}

function turnUsage(accum: { input: number; output: number; cacheWrite: number; cacheRead: number }) {
  return {
    input_tokens: accum.input,
    output_tokens: accum.output,
    cache_creation_input_tokens: accum.cacheWrite,
    cache_read_input_tokens: accum.cacheRead,
  }
}

function textValue(output: ToolCallOutput): string {
  return output.type === 'text' ? output.value : JSON.stringify(output.value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
