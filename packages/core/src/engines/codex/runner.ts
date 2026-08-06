import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_CAPABILITIES,
  PROTOCOL_VERSION,
  type ContentBlock,
  type CreateSessionRequest,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
} from '@workerdeck/protocol'
import {
  attachmentKind,
  attachmentRef,
  normalizeMediaType,
  type AttachmentInput,
} from '../../attachments.ts'
import type { PermissionDecision, Runner, SessionEventListener } from '../../runner-interface.ts'
import { JsonRpcError } from './jsonrpc.ts'
import type {
  AppServerConnection,
  AppServerConnectFn,
  AppServerItem,
  AppServerPlanUpdate,
  AppServerTokenUsage,
  AppServerTokenUsageUpdate,
  AppServerTurn,
  AppServerUnknownItem,
  AppServerUserInput,
} from './types.ts'

/**
 * thread/start's sandbox axis (string form) — our permission modes as codex
 * sandbox modes, the honest degradation: `default` → read-only ("would have
 * asked before acting" becomes "cannot act" — reads run, writes are refused by
 * the OS sandbox), `acceptEdits` → workspace-write, `bypassPermissions` →
 * danger-full-access. Always with `approvalPolicy: 'never'`: the protocol HAS
 * an ask channel (server→client requests), but this increment does not wire it
 * to the permission surface, so any policy that asks would stall a turn on our
 * own auto-decline.
 */
const THREAD_SANDBOX_BY_MODE: Partial<Record<PermissionMode, string>> = {
  default: 'read-only',
  acceptEdits: 'workspace-write',
  bypassPermissions: 'danger-full-access',
}

/** turn/start's sandboxPolicy axis (object form — same policy, second shape). */
const TURN_SANDBOX_BY_MODE: Partial<Record<PermissionMode, { type: string }>> = {
  default: { type: 'readOnly' },
  acceptEdits: { type: 'workspaceWrite' },
  bypassPermissions: { type: 'dangerFullAccess' },
}

/**
 * Minimal denials for the server→client requests `approvalPolicy: 'never'`
 * should already prevent: never approve, never hang (an unanswered request
 * wedges the turn). Each is the schema's own "no" — decline the action,
 * grant no permissions, answer no questions.
 */
const DECLINE_BY_METHOD: Record<string, object> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { permissions: {} },
  'item/tool/requestUserInput': { answers: {} },
  'mcpServer/elicitation/request': { action: 'decline' },
}

export type CodexRunnerConfig = CreateSessionRequest & {
  /** The injectable connection factory. The codex adapter passes
   * `connectAppServer` under the resolved binary; unit tests pass a scripted
   * peer. Required — this class never spawns anything itself. */
  connectFn: AppServerConnectFn
  /** Base environment for the codex child. Defaults to process.env. Passed to
   * spawn **complete** — a child env replaces, never merges. */
  env?: Record<string, string | undefined>
  /** CODEX_HOME pin from the profile (auth, config.toml, thread storage). */
  codexHome?: string
}

/** One queued user message: the input for exactly one turn. */
type QueuedTurn = { input: AppServerUserInput[] }

/** Everything one in-flight turn accumulates between `turn/start` and its
 * terminal `turn/completed`. */
type ActiveTurn = {
  /** Per-turn namespace for item-derived ids, kept unconditionally (the retired
   * exec transport's id-collision bug, b026e70): app-server item-id uniqueness
   * across turns (and across a respawned child) is not something we rely on. */
  nonce: string
  turnId?: string
  interrupted: boolean
  finalText?: string
  /** Last `error` notification, explaining a turn that fails without a message. */
  lastError?: string
  usage: AppServerTokenUsage
  sawUsage: boolean
  toolUseEmitted: Set<string>
  /** Last seen reasoning section index per item+kind, for '\n\n' separators. */
  sectionIndex: Map<string, number>
  settled: boolean
  resolve: (outcome: AppServerTurn) => void
  reject: (error: Error) => void
}

/**
 * The Codex engine, over the binary's `app-server` JSON-RPC surface: ONE
 * `codex app-server` child per *session* (spawned lazily, held across turns),
 * streaming `item/agentMessage/delta` and the reasoning deltas token-by-token
 * (`streaming: 'token'`). Follows `SessionRunner`'s event-log/seq/status
 * discipline with `AiSdkRunner`'s turn-chain (one turn at a time; sendMessage
 * queues). The first codex transport was `codex exec --experimental-json` (one
 * child per turn) — retired because its JSONL carries no partial messages, so
 * a turn could never stream.
 *
 * A dead child is a failed *turn*, not a failed session: the thread persists
 * on disk, the connection is dropped, and the next message spawns a fresh
 * child that `thread/resume`s the same thread id.
 */
export class CodexRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: CodexRunnerConfig
  #events: SessionEvent[] = []
  #listeners = new Set<SessionEventListener>()
  #seq = 0
  #status: SessionStatus = 'starting'
  #sdkSessionId: string | undefined
  #model: string | undefined
  #permissionMode: PermissionMode
  #reasoningEffort: string | undefined
  /** What the binary said the profile's defaults resolve to (thread/start
   * response) — lets `setModel(undefined)` mean "back to the default" even
   * though a turn/start override persists for subsequent turns. */
  #resolvedModel: string | undefined
  #resolvedEffort: string | undefined
  #queue: QueuedTurn[] = []
  #turnChain: Promise<void> = Promise.resolve()
  #activeTurn: ActiveTurn | undefined
  #connection: AppServerConnection | undefined
  #threadLoaded = false
  #numTurns = 0
  #totalCostUsd: number | undefined
  #lastActivityAt: number | undefined
  #started = false
  #closed = false
  /** Session temp dir for image attachments (`localImage` takes host paths). */
  #imageDir: string | undefined

  constructor(config: CodexRunnerConfig, id: string = randomUUID()) {
    const mode = config.permissionMode ?? 'default'
    if (!ENGINE_CAPABILITIES.codex.permissionModes.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the codex engine`)
    }
    if (config.forkSession) {
      throw new Error('the codex engine cannot fork a resumed thread')
    }
    this.#config = config
    this.#permissionMode = mode
    this.#model = config.model
    this.#reasoningEffort = config.reasoningEffort
    this.#sdkSessionId = config.resume
    this.id = id
    this.createdAt = Date.now()
  }

  /** The complete child environment — spawn env replaces process.env wholesale,
   * so this must carry everything a shell would, with the profile's CODEX_HOME
   * pin winning over operator env. */
  #childEnv(): Record<string, string> {
    const base = this.#config.env ?? process.env
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) env[key] = value
    }
    if (this.#config.codexHome) env.CODEX_HOME = this.#config.codexHome
    return env
  }

  get status(): SessionStatus {
    return this.#status
  }

  get sdkSessionId(): string | undefined {
    return this.#sdkSessionId
  }

  get lastSeq(): number {
    return this.#seq
  }

  get pendingApprovals(): PermissionRequest[] {
    return []
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.#config.cwd,
      profile: this.#config.profile,
      engine: 'codex',
      capabilities: ENGINE_CAPABILITIES.codex,
      model: this.#model ?? this.#resolvedModel,
      permissionMode: this.#permissionMode,
      canBypassPermissions: true,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      meta: this.#config.meta,
      title: this.#title(),
      totalCostUsd: this.#totalCostUsd,
      numTurns: this.#numTurns || undefined,
      lastActivityAt: this.#lastActivityAt,
    }
  }

  #title(): string | undefined {
    const metaTitle = this.#config.meta?.title
    if (typeof metaTitle === 'string' && metaTitle.length > 0) return metaTitle
    const prompt = this.#config.prompt
    if (!prompt) return undefined
    return prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt
  }

  start(): Promise<void> {
    if (this.#started) return this.#turnChain
    this.#started = true
    this.#setStatus('idle')
    if (this.#config.prompt) this.sendMessage(this.#config.prompt)
    return this.#turnChain
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#closed) throw new Error('session is closed')
    const input = this.#buildInput(text, attachments ?? [])
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid: randomUUID(),
    })
    this.#queue.push({ input })
    this.#scheduleTurn()
  }

  /**
   * App-server input for a message with attachments: images land in a session
   * temp dir and travel as `localImage` host paths, text files inline into the
   * prompt in the shared named envelope, PDF has no representation (the
   * gateway's 415 normally refuses it first).
   */
  #buildInput(text: string, attachments: readonly AttachmentInput[]): AppServerUserInput[] {
    const parts: AppServerUserInput[] = []
    for (const attachment of attachments) {
      const mediaType = normalizeMediaType(attachment.mediaType)
      switch (attachmentKind(mediaType)) {
        case 'image': {
          this.#imageDir ??= join(tmpdir(), `workerdeck-codex-${this.id}`)
          mkdirSync(this.#imageDir, { recursive: true })
          const ext = mediaType.split('/')[1] ?? 'bin'
          const path = join(this.#imageDir, `${attachment.id}.${ext}`)
          writeFileSync(path, Buffer.from(attachment.data, 'base64'))
          parts.push({ type: 'localImage', path })
          break
        }
        case 'text':
          parts.push({
            type: 'text',
            text:
              `<attachment name="${attachment.name}" type="${mediaType}">\n` +
              `${Buffer.from(attachment.data, 'base64').toString('utf8')}\n</attachment>`,
          })
          break
        default:
          throw new Error(
            `unsupported attachment media type for the codex engine: ${attachment.mediaType}`,
          )
      }
    }
    if (text) parts.push({ type: 'text', text })
    return parts
  }

  resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false
  }

  async interrupt(): Promise<void> {
    const active = this.#activeTurn
    const connection = this.#connection
    if (active && !active.settled) {
      active.interrupted = true
      if (connection && active.turnId && this.#sdkSessionId) {
        try {
          await connection.request('turn/interrupt', {
            threadId: this.#sdkSessionId,
            turnId: active.turnId,
          })
          // The terminal turn/completed (status 'interrupted') settles the turn.
        } catch {
          // The turn may already be over, or the child gone — both settle it.
        }
      } else if (connection) {
        // No turn id yet (interrupted before turn/started): there is nothing
        // to address the request to, so end the child — the thread survives on
        // disk and the next message respawns into it.
        // The onClose rejection settles the turn; `interrupted` explains it.
        connection.close()
        if (this.#connection === connection) this.#connection = undefined
        active.reject(new Error('interrupted'))
      }
    }
    await this.#turnChain
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!ENGINE_CAPABILITIES.codex.permissionModes.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the codex engine`)
    }
    if (this.#activeTurn) {
      throw new Error("cannot change the permission mode mid-turn (the running turn's sandbox is fixed)")
    }
    this.#permissionMode = mode
    this.#emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    if (this.#activeTurn) {
      throw new Error("cannot change the model mid-turn (the running turn's model is fixed)")
    }
    this.#model = model
    this.#emit({ type: 'model_changed', model })
  }

  fail(message: string): void {
    if (this.#closed) return
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.#closed) return
    this.#closed = true
    this.#queue.length = 0
    this.#connection?.close()
    this.#connection = undefined
    this.#activeTurn?.reject(new Error('session closed'))
    if (this.#imageDir) {
      try {
        rmSync(this.#imageDir, { recursive: true, force: true })
      } catch {
        // Temp-dir cleanup must never break teardown.
      }
    }
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
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
   * The session's live connection with its thread loaded, (re)building both as
   * needed: spawn + `initialize`/`initialized` on a fresh child, then
   * `thread/start` (new) or `thread/resume` (a create-request `resume`, or a
   * thread orphaned by a dead child). The response's resolved model/effort are
   * kept so per-turn overrides can name "the profile default" explicitly.
   */
  async #ensureThread(): Promise<AppServerConnection> {
    if (this.#closed) throw new Error('session is closed')
    let connection = this.#connection
    if (!connection) {
      connection = this.#config.connectFn({ env: this.#childEnv() })
      this.#connection = connection
      this.#threadLoaded = false
      connection.onNotification((method, params) => this.#handleNotification(method, params))
      connection.onRequest((method, params) => this.#answerServerRequest(method, params))
      connection.onClose((message) => {
        if (this.#connection === connection) {
          this.#connection = undefined
          this.#threadLoaded = false
        }
        // A child dying mid-turn fails that turn (with the exit diagnostic);
        // idle, there is nothing to settle and the next turn respawns.
        this.#activeTurn?.reject(new Error(message))
      })
      await connection.request('initialize', {
        clientInfo: {
          name: 'workerdeck',
          title: 'WorkerDeck',
          version: `protocol-${PROTOCOL_VERSION}`,
        },
      })
      connection.notify('initialized')
    }
    if (!this.#threadLoaded) {
      const options: Record<string, unknown> = {
        cwd: this.#config.cwd,
        approvalPolicy: 'never',
        sandbox: THREAD_SANDBOX_BY_MODE[this.#permissionMode],
      }
      if (this.#model) options.model = this.#model
      const result = (this.#sdkSessionId
        ? await connection.request('thread/resume', { threadId: this.#sdkSessionId, ...options })
        : await connection.request('thread/start', options)) as {
        thread?: { id?: string }
        model?: string | null
        reasoningEffort?: string | null
      }
      if (typeof result?.thread?.id === 'string') this.#sdkSessionId = result.thread.id
      if (typeof result?.model === 'string') this.#resolvedModel = result.model
      if (typeof result?.reasoningEffort === 'string') this.#resolvedEffort = result.reasoningEffort
      this.#threadLoaded = true
    }
    return connection
  }

  async #runTurn(): Promise<void> {
    if (this.#closed) return
    const turn = this.#queue.shift()
    if (!turn) return
    this.#setStatus('running')
    const startedAt = Date.now()
    const active: ActiveTurn = {
      nonce: randomUUID(),
      interrupted: false,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      sawUsage: false,
      toolUseEmitted: new Set(),
      sectionIndex: new Map(),
      settled: false,
      resolve: () => {},
      reject: () => {},
    }
    const outcome = new Promise<AppServerTurn>((resolve, reject) => {
      active.resolve = (turnResult) => {
        if (active.settled) return
        active.settled = true
        resolve(turnResult)
      }
      active.reject = (error) => {
        if (active.settled) return
        active.settled = true
        reject(error)
      }
    })
    this.#activeTurn = active
    try {
      const connection = await this.#ensureThread()
      const params: Record<string, unknown> = {
        threadId: this.#sdkSessionId,
        input: turn.input,
        cwd: this.#config.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: TURN_SANDBOX_BY_MODE[this.#permissionMode],
      }
      // Overrides persist "for this turn and subsequent turns", so name the
      // model/effort explicitly every turn — the resolved default when no
      // override is set, which is what makes setModel(undefined) a real reset.
      const model = this.#model ?? this.#resolvedModel
      if (model) params.model = model
      const effort = this.#reasoningEffort ?? this.#resolvedEffort
      if (effort) params.effort = effort
      // The terminal signal is the turn/completed NOTIFICATION; the response's
      // timing is unspecified, so it only contributes its turn id, a JSON-RPC
      // error (no turn ran → fail now), or — defensively — a terminal status.
      connection.request('turn/start', params).then(
        (result) => {
          const started = (result as { turn?: AppServerTurn })?.turn
          if (!started) return
          active.turnId ??= started.id
          if (started.status && started.status !== 'inProgress') active.resolve(started)
        },
        (error: unknown) => active.reject(error instanceof Error ? error : new Error(String(error))),
      )
      const result = await outcome
      if (this.#closed) return
      if (result.status === 'completed') {
        this.#finishTurn('success', startedAt, active)
      } else {
        const reason =
          result.status === 'interrupted'
            ? 'interrupted'
            : (result.error?.message ??
              active.lastError ??
              'codex app-server ended the turn without a result')
        this.#finishTurn('failure', startedAt, active, [reason])
      }
    } catch (error) {
      if (this.#closed) return
      // A failed turn is not a failed session: the thread persists on disk and
      // the next message reconnects and resumes it.
      const message = error instanceof Error ? error.message : String(error)
      this.#finishTurn('failure', startedAt, active, [active.interrupted ? 'interrupted' : message])
    } finally {
      if (this.#activeTurn === active) this.#activeTurn = undefined
    }
  }

  // -------------------------------------------------------------------------
  // Server→client traffic
  // -------------------------------------------------------------------------

  #handleNotification(method: string, params: unknown): void {
    if (this.#closed) return
    const active = this.#activeTurn
    switch (method) {
      case 'thread/started': {
        const thread = (params as { thread?: { id?: string } })?.thread
        if (typeof thread?.id === 'string') this.#sdkSessionId = thread.id
        return
      }
      case 'turn/started': {
        const turn = (params as { turn?: AppServerTurn })?.turn
        if (active && turn && !active.turnId) active.turnId = turn.id
        return
      }
      case 'turn/completed': {
        const turn = (params as { turn?: AppServerTurn })?.turn
        if (active && turn) active.resolve(turn)
        return
      }
      case 'item/started':
      case 'item/updated': {
        if (!active) return
        const item = (params as { item?: AppServerItem })?.item
        if (item) this.#handleItemProgress(item, active)
        return
      }
      case 'item/completed': {
        if (!active) return
        const item = (params as { item?: AppServerItem })?.item
        if (item) this.#handleItemCompleted(item, active)
        return
      }
      case 'item/agentMessage/delta': {
        if (!active) return
        const delta = (params as { delta?: string })?.delta
        if (typeof delta === 'string' && delta) {
          this.#emitDelta({ type: 'text_delta', text: delta })
        }
        return
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        if (!active) return
        const payload = params as {
          delta?: string
          itemId?: string
          contentIndex?: number
          summaryIndex?: number
        }
        if (typeof payload?.delta !== 'string' || !payload.delta) return
        // Section boundaries (a new summary/content entry) render as paragraph
        // breaks — the completed item joins sections with '\n\n' too.
        const index = payload.contentIndex ?? payload.summaryIndex ?? 0
        const key = `${payload.itemId ?? ''}:${method}`
        const previous = active.sectionIndex.get(key)
        active.sectionIndex.set(key, index)
        const separator = previous !== undefined && index > previous ? '\n\n' : ''
        this.#emitDelta({ type: 'thinking_delta', thinking: separator + payload.delta })
        return
      }
      case 'thread/tokenUsage/updated': {
        if (!active) return
        const last = (params as AppServerTokenUsageUpdate)?.tokenUsage?.last
        if (!last) return
        // `last` is one model request; a tool-looping turn makes several. The
        // per-turn number the Anthropic convention wants is their sum.
        active.sawUsage = true
        active.usage.inputTokens += last.inputTokens ?? 0
        active.usage.cachedInputTokens += last.cachedInputTokens ?? 0
        active.usage.cacheWriteInputTokens =
          (active.usage.cacheWriteInputTokens ?? 0) + (last.cacheWriteInputTokens ?? 0)
        active.usage.outputTokens += last.outputTokens ?? 0
        active.usage.reasoningOutputTokens += last.reasoningOutputTokens ?? 0
        return
      }
      case 'turn/plan/updated': {
        // v2's todo list, published as the codex.todo_list sdk_event payload
        // both clients already render.
        if (!active) return
        const plan = (params as AppServerPlanUpdate)?.plan
        if (!Array.isArray(plan)) return
        this.#emit({
          type: 'sdk_event',
          payload: {
            type: 'codex.todo_list',
            id: `${active.nonce}:plan`,
            items: plan.map((step) => ({ text: step.step, completed: step.status === 'completed' })),
          },
        })
        return
      }
      case 'error': {
        // Mostly retry noise (`willRetry: true`); keep the last message so a
        // turn that fails without its own error still explains itself.
        const error = (params as { error?: { message?: string } })?.error
        if (active && typeof error?.message === 'string') active.lastError = error.message
        return
      }
      default:
        // The app-server surface is wide (mcpServer/*, account/*, thread
        // housekeeping…) — everything unmapped is deliberately dropped.
        return
    }
  }

  /** Answer a server→client request. Approvals cannot legitimately occur under
   * `approvalPolicy: 'never'`, so anything arriving is declined — visibly (an
   * sdk_event), never approved, and never left hanging. */
  async #answerServerRequest(method: string, _params: unknown): Promise<unknown> {
    const decline = DECLINE_BY_METHOD[method]
    if (decline) {
      this.#emit({ type: 'sdk_event', payload: { type: 'codex.approval_auto_declined', method } })
      return decline
    }
    throw new JsonRpcError(-32601, `workerdeck does not handle server request '${method}'`)
  }

  // -------------------------------------------------------------------------
  // Item mapping (the v2 camelCase vocabulary → protocol events)
  // -------------------------------------------------------------------------

  /** Tool calls surface as tool_use when they start; text and reasoning stream
   * natively via the delta notifications. */
  #handleItemProgress(item: AppServerItem, active: ActiveTurn): void {
    const id = `${active.nonce}:${item.id}`
    if (item.type === 'commandExecution' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, 'CodexCommand', { command: item.command })
      return
    }
    if (item.type === 'mcpToolCall' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, `mcp__${item.server}__${item.tool}`, item.arguments)
    }
  }

  #handleItemCompleted(item: AppServerItem, active: ActiveTurn): void {
    const id = `${active.nonce}:${item.id}`
    switch (item.type) {
      case 'userMessage':
        // The echo of our own turn/start input — already in the log.
        return
      case 'agentMessage': {
        const text = typeof item.text === 'string' ? item.text : ''
        this.#emitAssistant(id, [{ type: 'text', text }])
        active.finalText = text
        return
      }
      case 'reasoning': {
        // `summary` is what streamed (the default config); raw `content` only
        // exists when the operator's config enables it. Joined the way the
        // deltas rendered: sections as paragraphs.
        const summary = Array.isArray(item.summary) ? item.summary.filter(Boolean) : []
        const content = Array.isArray(item.content) ? item.content.filter(Boolean) : []
        const thinking = (summary.length > 0 ? summary : content).join('\n\n')
        if (thinking) this.#emitAssistant(id, [{ type: 'thinking', thinking }])
        return
      }
      case 'commandExecution': {
        if (!active.toolUseEmitted.has(id)) {
          active.toolUseEmitted.add(id)
          this.#emitToolUse(id, 'CodexCommand', { command: item.command })
        }
        const exitCode = item.exitCode ?? undefined
        const failed =
          item.status === 'failed' ||
          item.status === 'declined' ||
          (exitCode !== undefined && exitCode !== 0)
        const output =
          (item.aggregatedOutput ?? '') +
          (exitCode !== undefined && exitCode !== 0 ? `\n(exit code ${exitCode})` : '')
        this.#emitToolResult(id, output, failed)
        return
      }
      case 'fileChange': {
        // Post-hoc by design: under 'never' the patch already applied or
        // failed — there is no proposal stage. v2's `kind` is an object
        // (`{type: 'update', …}`), mapped defensively.
        this.#emitToolUse(id, 'CodexFileChange', { changes: item.changes })
        const lines = item.changes.map((change) => {
          const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type
          return `${kind ?? 'change'}: ${change.path}`
        })
        this.#emitToolResult(
          id,
          lines.join('\n') || item.status,
          item.status === 'failed' || item.status === 'declined',
        )
        return
      }
      case 'mcpToolCall': {
        if (!active.toolUseEmitted.has(id)) {
          active.toolUseEmitted.add(id)
          this.#emitToolUse(id, `mcp__${item.server}__${item.tool}`, item.arguments)
        }
        const isError = (item.error !== undefined && item.error !== null) || item.status === 'failed'
        this.#emitToolResult(
          id,
          item.error?.message ??
            (item.result === undefined || item.result === null ? '' : JSON.stringify(item.result)),
          isError,
        )
        return
      }
      case 'webSearch':
        this.#emitToolUse(id, 'CodexWebSearch', { query: item.query })
        this.#emitToolResult(id, '', false)
        return
      default: {
        const unknown = item as AppServerUnknownItem
        this.#emit({ type: 'sdk_event', payload: { type: `codex.${unknown.type}`, item: unknown } })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Emission (the AiSdkRunner tool_result shape, so the reducer and both UIs
  // render their existing cards unchanged)
  // -------------------------------------------------------------------------

  #emitDelta(delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }): void {
    if (this.#config.includePartialMessages === false) return
    this.#emit({
      type: 'stream_delta',
      event: { type: 'content_block_delta', delta },
      parentToolUseId: null,
      uuid: randomUUID(),
    })
  }

  #emitAssistant(uuid: string, content: ContentBlock[]): void {
    this.#emit({
      type: 'assistant_message',
      message: { role: 'assistant', content, model: this.#model ?? this.#resolvedModel },
      parentToolUseId: null,
      uuid,
    })
  }

  #emitToolUse(id: string, name: string, input: unknown): void {
    this.#emit({
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
        model: this.#model ?? this.#resolvedModel,
      },
      parentToolUseId: null,
      uuid: `${id}-use`,
    })
  }

  #emitToolResult(toolUseId: string, content: string, isError: boolean): void {
    this.#emit({
      type: 'user_message',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError || undefined },
        ],
      },
      parentToolUseId: null,
      synthetic: true,
      uuid: `${toolUseId}-result`,
    })
  }

  /**
   * Per-turn usage re-mapped to the Anthropic accounting convention the whole
   * stack assumes (GOTCHAS §Codex engine): OpenAI's `inputTokens` includes the
   * cached share, so input excludes it (else queue token budgets double-count
   * cache-heavy runs); reasoning tokens are billed output; `totalCostUsd: 0` =
   * unknown, the AiSdkRunner precedent. Usage is summed from the turn's
   * `thread/tokenUsage/updated` notifications — `turn/completed` carries none.
   */
  #finishTurn(
    kind: 'success' | 'failure',
    startedAt: number,
    active: ActiveTurn,
    errors?: string[],
  ): void {
    this.#numTurns += 1
    this.#totalCostUsd = 0
    const usage = active.sawUsage ? active.usage : undefined
    this.#emit({
      type: 'turn_result',
      subtype: kind === 'success' ? 'success' : 'error_during_execution',
      isError: kind !== 'success',
      durationMs: Date.now() - startedAt,
      numTurns: this.#numTurns,
      totalCostUsd: 0,
      result: kind === 'success' ? (active.finalText ?? '') : undefined,
      errors,
      usage: usage
        ? {
            input_tokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
            output_tokens: usage.outputTokens + usage.reasoningOutputTokens,
            cache_creation_input_tokens: usage.cacheWriteInputTokens ?? 0,
            cache_read_input_tokens: usage.cachedInputTokens,
          }
        : undefined,
    })
    this.#setStatus('idle')
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
