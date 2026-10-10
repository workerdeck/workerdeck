import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_CAPABILITIES,
  supportsPermissionMode,
  type McpServerStatusInfo,
  type PermissionMode,
  type PermissionRequest,
  type SessionEventBody,
  type SessionInfo,
  tokenUsageFromWire,
  errorMessage,
} from '@workerdeck/protocol'
import { attachmentKind, normalizeMediaType, type AttachmentInput } from '../../lib/attachments.ts'
import type { ClearContextOptions, EngineRunnerConfig, Runner, SendMessageOptions, SleepResult } from '../../runner-interface.ts'
import { agentResetFields } from '../../lib/context-reset.ts'
import { checklistFromPlan, sameChecklist } from '../../lib/checklist.ts'
import { EngineRunner, type SessionReportFacts } from '../../lib/engine-runner.ts'
import { type CloseReason, type RunnerCoreHooks } from '../../lib/runner-core.ts'
import { resolveInstructions } from '../../lib/instructions.ts'
import { assertEffort, effortDefaultFor, modelEfforts } from '../../lib/effort.ts'
import { withPeerContext } from '../../lib/peers.ts'
import { liveContextFromReading, type LiveContext } from '../../lib/session-report.ts'
import { runSessionTool, sessionToolSpecs } from '../../lib/session-tools.ts'
import { isShellToolName, shellToolNeedsCard, shellWriteDeniedText } from '../../lib/shells.ts'
import { ToolOutputTails } from '../../lib/tool-output.ts'
import {
  APPROVAL_CHANNELS,
  SHELL_WRITE_CHANNEL,
  answerApproval,
  offeredDecisions,
  recommendedAnswers,
  type ApprovalChannel,
  type ShellWriteVerdict,
} from './approvals.ts'
import { CODEX_CATALOG } from './catalog.ts'
import { codexChildEnv, INITIALIZE_PARAMS } from './connect.ts'
import { incompleteHistoryNotice, loadHistory, replayTurns, type HistorySink, type ResumedHistory } from './history.ts'
import {
  emitDelta,
  fileProducedEvent,
  itemCompleted,
  itemContext,
  itemProgress,
  reasoningDelta,
  settleAgentTurn,
  threadIdOf,
  type ItemContext,
} from './items.ts'
import { JsonRpcError } from './jsonrpc.ts'
import { mcpServerInfo, type McpStartupStatus } from './mcp.ts'
import { codexMcpServers, undeclaredFilterServers } from './mcp-config.ts'
import {
  SHELL_WRITE_GATE_MODES,
  modePolicy,
  readWorkspaceWrite,
  threadSandbox,
  turnSandboxPolicy,
  type CodexWorkspaceWrite,
} from './policy.ts'
import { mentionsSkill, skillCatalog, withSkillItems } from './skills.ts'
import { CodexAgentTracker, type ItemScope } from './subagents.ts'
import { untrustedProjectNotice } from './trust.ts'
import type {
  AppServerConnection,
  AppServerConnectFn,
  AppServerDynamicToolCallParams,
  AppServerHistoryTurn,
  AppServerItem,
  AppServerMcpServerStatusResponse,
  AppServerMcpStatusUpdate,
  AppServerPlanUpdate,
  AppServerRateLimits,
  AppServerSkillsListResponse,
  AppServerTokenUsage,
  AppServerTokenUsageUpdate,
  AppServerTurn,
  AppServerUserInput,
} from './types.ts'

const THREAD_SCOPED_NOTIFICATIONS = new Set(['turn/started', 'turn/completed', 'thread/tokenUsage/updated', 'turn/plan/updated'])

const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const

export type CodexRunnerConfig = EngineRunnerConfig & {
  connectFn: AppServerConnectFn
  codexHome?: string
  codexPathOverride?: string
  backfillHistory?: boolean
}

type QueuedTurn = { input: AppServerUserInput[] }

type AppServerThreadResult = {
  thread?: { id?: string; turns?: AppServerHistoryTurn[] }
  model?: string | null
  reasoningEffort?: string | null
  turnsBackwardsCursor?: string | null
}

function steerUnsupported(error: unknown): boolean {
  if (!(error instanceof JsonRpcError)) {
    return false
  }
  // Measured against 0.153.4: an unknown method is a serde miss on the ClientRequest enum, -32600 with this message, never -32601.
  return error.code === -32601 || (error.code === -32600 && error.message.includes('unknown variant `turn/steer`'))
}

function rolloutMissing(error: unknown): boolean {
  return error instanceof JsonRpcError && error.code === -32600 && error.message.startsWith('no rollout found for thread id')
}

function threadLostNotice(threadId: string): string {
  return (
    `Codex has no record of this session's thread (${threadId}): it was never saved to CODEX_HOME, or has since been removed. ` +
    'A new thread was started, so the model begins without the earlier conversation.'
  )
}

function rateLimitWindowName(minutes: number | null | undefined): string | undefined {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return undefined
  }
  if (minutes === 300) {
    return 'five_hour'
  }
  if (minutes === 10_080) {
    return 'seven_day'
  }
  return `window_${minutes}m`
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function assertPermissionMode(mode: PermissionMode): void {
  if (!supportsPermissionMode('codex', mode)) {
    throw new Error(`permission mode '${mode}' is not supported by the codex engine`)
  }
}

type ActiveTurn = ItemScope & {
  turnId?: string
  interrupted: boolean
  finalText?: string
  lastError?: string
  usage: AppServerTokenUsage
  sawUsage: boolean
  contextTokens?: number
  contextWindow?: number
  settled: boolean
  steerGate: Promise<void>
  openSteerGate: () => void
  steerChain: Promise<void>
  resolve: (outcome: AppServerTurn) => void
  reject: (error: Error) => void
}

export class CodexRunner extends EngineRunner<CodexRunnerConfig> implements Runner {
  readonly #cwd: string
  readonly #instructions: string | undefined
  #sdkSessionId: string | undefined
  #model: string | undefined
  #permissionMode: PermissionMode
  #reasoningEffort: string | undefined
  #effortExplicit: boolean
  #effort: string | undefined
  #resolvedModel: string | undefined
  #planType: string | undefined
  #resolvedEffort: string | undefined
  #queue: QueuedTurn[] = []
  #turnChain: Promise<void> = Promise.resolve()
  #activeTurn: ActiveTurn | undefined
  #connection: AppServerConnection | undefined
  #workspaceWrite: CodexWorkspaceWrite | undefined
  #threadLoaded = false
  #asleep = false
  #threadMaterialized: boolean
  #numTurns = 0
  #started = false
  #imageDir: string | undefined
  #backfillPending = false
  #resumedHistory: ResumedHistory | undefined
  #replayingHistory = false
  #skillsFingerprint: string | undefined
  #skillsRefresh: Promise<void> | undefined
  #skillPaths = new Map<string, string>()
  #producedPaths = new Set<string>()
  #mcpStatus = new Map<string, McpStartupStatus>()
  #agents = new CodexAgentTracker()
  #outputTails = new ToolOutputTails((body) => this.core.emit(body))
  #idleScope: ItemScope = { nonce: 'codex', toolUseEmitted: new Set(), sectionIndex: new Map() }
  #clearedThreads = new Set<string>()
  #cannotSteer = new WeakSet<AppServerConnection>()
  #clearsPending = 0
  readonly #sink: HistorySink = {
    agents: this.#agents,
    model: () => this.#model ?? this.#resolvedModel,
    rootThreadId: () => this.#sdkSessionId,
    replaying: () => this.#replayingHistory,
    partials: () => this.config.includePartialMessages !== false,
    emit: (body) => {
      this.core.emit(body)
    },
    fileProduced: (path, toolUseId) => this.#emitFileProduced(path, toolUseId),
    finalText: (text) => {
      if (this.#activeTurn) {
        this.#activeTurn.finalText = text
      }
    },
    closed: () => this.core.closed,
    setReplaying: (replaying) => {
      this.#replayingHistory = replaying
    },
  }

  constructor(config: CodexRunnerConfig, id: string = randomUUID()) {
    super(config, id, Date.now())
    const mode = config.permissionMode ?? 'default'
    assertPermissionMode(mode)
    if (config.forkSession) {
      throw new Error('the codex engine cannot fork a resumed thread')
    }
    if (!config.cwd) {
      throw new Error('the codex engine requires a cwd')
    }
    this.#cwd = config.cwd
    this.#permissionMode = mode
    this.#model = config.model
    this.#effortExplicit = config.reasoningEffort !== undefined
    this.#reasoningEffort = config.reasoningEffort ?? effortDefaultFor(config.effortDefaults, CODEX_CATALOG.models, config.model)
    this.#sdkSessionId = config.resume
    this.#threadMaterialized = config.resume !== undefined
    this.#instructions = resolveInstructions(config.instructions, { sessionId: id, cwd: config.cwd, profile: config.profile })
  }

  #childEnv(): Record<string, string> {
    return codexChildEnv(this.config.env ?? process.env, this.config.codexHome)
  }

  protected override coreHooks(): RunnerCoreHooks {
    return { prepare: (body) => this.#markReplay(body), observe: (body) => this.#outputTails.observe(body) }
  }

  get sdkSessionId(): string | undefined {
    return this.#resumableThreadId()
  }

  // Codex writes a thread's rollout on its first turn, not on `thread/start`: until then the id resumes nothing.
  #resumableThreadId(): string | undefined {
    return this.#threadMaterialized ? this.#sdkSessionId : undefined
  }

  info(): SessionInfo {
    return {
      ...this.baseInfo(),
      sdkSessionId: this.#resumableThreadId(),
      cwd: this.#cwd,
      engine: 'codex',
      capabilities: ENGINE_CAPABILITIES.codex,
      model: this.#model ?? this.#resolvedModel,
      ...(this.#currentEffort() !== undefined ? { effort: this.#currentEffort() } : {}),
      permissionMode: this.#permissionMode,
      canBypassPermissions: true,
      totalCostUsd: this.core.cost.reportedCostUsd,
      numTurns: this.#numTurns || undefined,
      subagents: this.#agents.list(),
      ...(this.#asleep ? { engineAsleep: true as const } : {}),
    }
  }

  get engineAsleep(): boolean {
    return this.#asleep
  }

  // The next turn reconnects and `thread/resume`s through `#ensureThread`, the same path a crashed child takes.
  async sleep(): Promise<SleepResult> {
    const refused = this.#sleepRefusal()
    if (refused) {
      return { ok: false, reason: refused }
    }
    if (this.#asleep) {
      return { ok: true }
    }
    const connection = this.#connection
    this.#asleep = true
    this.#connection = undefined
    this.#threadLoaded = false
    connection?.close()
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
    if (this.#activeTurn || this.#queue.length > 0 || this.#clearsPending > 0 || this.#backfillPending) {
      return 'a turn is on its way'
    }
    if (this.#agents.list()?.some((agent) => agent.status === 'running')) {
      return 'a subagent is still running'
    }
    return undefined
  }

  #wake(): void {
    if (!this.#asleep) {
      return
    }
    this.#asleep = false
    this.core.emit({ type: 'engine_sleep', asleep: false })
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#turnChain
    }
    this.#started = true
    this.#warnUntrustedProject()
    if (this.config.resume && this.config.backfillHistory !== false) {
      this.#backfillPending = true
      this.#turnChain = this.#turnChain.then(() => this.#backfillHistory())
    } else {
      this.core.setStatus('idle')
    }
    if (this.config.startAsleep && !this.config.prompt) {
      this.#turnChain = this.#turnChain.then(async () => {
        await this.sleep()
      })
    }
    if (this.config.prompt) {
      this.sendMessage(this.config.prompt)
    }
    if (!this.config.prompt && !this.config.resume) {
      void this.#probeSkills()
    }
    return this.#turnChain
  }

  #warnUntrustedProject(): void {
    if (this.#permissionMode !== 'default') {
      return
    }
    try {
      const env = this.#childEnv()
      const pin = env.CODEX_HOME
      if (pin !== undefined && pin.length === 0) {
        return
      }
      const codexHome = pin ?? join(env.HOME ?? homedir(), '.codex')
      const message = untrustedProjectNotice({ cwd: this.#cwd, codexHome })
      if (message) {
        this.core.emit({ type: 'session_error', message })
      }
    } catch {}
  }

  async #probeSkills(): Promise<void> {
    let connection: AppServerConnection | undefined
    try {
      connection = await this.#openScratchConnection()
      if (this.core.closed) {
        return
      }
      await this.#refreshSkills(connection)
    } catch {
    } finally {
      connection?.close()
    }
  }

  async #openScratchConnection(): Promise<AppServerConnection> {
    const connection = this.config.connectFn({ env: this.#childEnv() })
    try {
      await connection.request('initialize', INITIALIZE_PARAMS)
      connection.notify('initialized')
      return connection
    } catch (error) {
      connection.close()
      throw error
    }
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void {
    this.assertAccepting()
    if (text.trim() === '/clear' && !attachments?.length && !options?.origin) {
      void this.clearContext().catch((error: unknown) => {
        this.core.emit({
          type: 'session_error',
          message: `could not clear the conversation: ${errorMessage(error)}`,
        })
      })
      return
    }
    const input = this.#buildInput(withPeerContext(text, options), attachments ?? [])
    this.#wake()
    const echo = (): void => this.echoUser(text, attachments, options)
    if (this.#backfillPending) {
      this.#turnChain = this.#turnChain.then(echo)
    } else {
      echo()
    }
    this.#dispatch(input)
  }

  #dispatch(input: AppServerUserInput[]): void {
    const active = this.#activeTurn
    if (!active || !this.#steerable(active)) {
      this.#enqueueTurn(input)
      return
    }
    active.steerChain = active.steerChain.then(async () => {
      await active.steerGate
      await this.#steer(active, input)
    })
  }

  #steerable(active: ActiveTurn): boolean {
    if (active.settled || active.interrupted || this.#clearsPending > 0) {
      return false
    }
    return !this.#connection || !this.#cannotSteer.has(this.#connection)
  }

  async #steer(active: ActiveTurn, input: AppServerUserInput[]): Promise<void> {
    const connection = this.#connection
    const threadId = this.#sdkSessionId
    const turnId = active.turnId
    if (!connection || !threadId || !turnId || active.settled || active.interrupted || this.#cannotSteer.has(connection)) {
      this.#enqueueTurn(input)
      return
    }
    try {
      await connection.request('turn/steer', { threadId, expectedTurnId: turnId, input })
    } catch (error) {
      if (steerUnsupported(error)) {
        this.#cannotSteer.add(connection)
      }
      this.#enqueueTurn(input)
    }
  }

  #enqueueTurn(input: AppServerUserInput[]): void {
    if (this.core.closed) {
      return
    }
    this.#queue.push({ input })
    this.#scheduleTurn()
  }

  #adoptTurnId(active: ActiveTurn, turnId: string | undefined): void {
    if (active.turnId || typeof turnId !== 'string' || !turnId) {
      return
    }
    active.turnId = turnId
    active.openSteerGate()
  }

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
        case 'text': {
          parts.push({
            type: 'text',
            text:
              `<attachment name="${attachment.name}" type="${mediaType}">\n` +
              `${Buffer.from(attachment.data, 'base64').toString('utf8')}\n</attachment>`,
          })
          break
        }
        default: {
          throw new Error(`unsupported attachment media type for the codex engine: ${attachment.mediaType}`)
        }
      }
    }
    if (text) {
      parts.push({ type: 'text', text })
    }
    const context = this.localCommands.take()
    if (context) {
      parts.unshift({ type: 'text', text: context })
    }
    return withSkillItems(parts, this.#skillPaths)
  }

  async interrupt(): Promise<void> {
    this.core.settleAllApprovals({ behavior: 'deny', message: 'interrupted', interrupt: true }, 'policy')
    await this.#interruptTurn()
    await this.#turnChain
  }

  async clearContext(options?: ClearContextOptions): Promise<void> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
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

  async #clearNow(options?: ClearContextOptions): Promise<void> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    const previousThread = this.#sdkSessionId
    const previousMaterialized = this.#threadMaterialized
    this.#sdkSessionId = undefined
    this.#threadMaterialized = false
    this.#threadLoaded = false
    if (this.#connection) {
      try {
        await this.#ensureThread()
      } catch (error) {
        this.#sdkSessionId = previousThread
        this.#threadMaterialized = previousMaterialized
        this.#threadLoaded = false
        throw error
      }
    }
    for (const agent of this.#agents.threadIds()) {
      this.#clearedThreads.add(agent)
    }
    this.#agents.forget()
    this.core.settleAllApprovals({ behavior: 'deny', message: 'the conversation was cleared' }, 'policy')
    this.#resumedHistory = undefined
    this.localCommands.clear()
    this.core.emit({ type: 'conversation_reset', sdkSessionId: this.#resumableThreadId(), ...agentResetFields(options) })
  }

  async #interruptTurn(): Promise<void> {
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
        } catch {}
      } else if (connection) {
        // No turn id yet: nothing to address the interrupt to, so end the child and let the next message respawn.
        connection.close()
        if (this.#connection === connection) {
          this.#connection = undefined
        }
        active.reject(new Error('interrupted'))
      }
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    assertPermissionMode(mode)
    if (this.#activeTurn) {
      throw new Error("cannot change the permission mode mid-turn (the running turn's sandbox is fixed)")
    }
    this.#permissionMode = mode
    this.core.emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    if (this.#activeTurn) {
      throw new Error("cannot change the model mid-turn (the running turn's model is fixed)")
    }
    this.#model = model
    this.core.emit({ type: 'model_changed', model })
    const fallback = effortDefaultFor(this.config.effortDefaults, CODEX_CATALOG.models, model)
    if (fallback !== undefined) {
      this.#effortExplicit = false
      this.#reasoningEffort = fallback
    } else if (!this.#effortExplicit) {
      this.#reasoningEffort = undefined
    }
    const supported = modelEfforts(CODEX_CATALOG.models, model ?? this.#resolvedModel)
    if (this.#reasoningEffort !== undefined && supported && !supported.includes(this.#reasoningEffort)) {
      this.#reasoningEffort = undefined
    }
    this.#reportEffort()
  }

  async setEffort(effort?: string): Promise<void> {
    assertEffort(effort, modelEfforts(CODEX_CATALOG.models, this.#model ?? this.#resolvedModel))
    this.#effortExplicit = effort !== undefined
    this.#reasoningEffort = effort ?? effortDefaultFor(this.config.effortDefaults, CODEX_CATALOG.models, this.#model ?? this.#resolvedModel)
    this.#reportEffort()
  }

  #currentEffort(): string | undefined {
    return this.#reasoningEffort ?? this.#resolvedEffort
  }

  #reportEffort(): void {
    const effort = this.#currentEffort()
    if (effort === this.#effort || effort === undefined) {
      return
    }
    this.#effort = effort
    this.core.emit({ type: 'effort_changed', effort })
  }

  close(reason: CloseReason = 'client'): void {
    this.core.close(reason, () => {
      this.#queue.length = 0
      this.localCommands.clear()
      this.#connection?.close()
      this.#connection = undefined
      this.#agents.sweep()
      this.#outputTails.clear()
      this.#activeTurn?.reject(new Error('session closed'))
      if (this.#imageDir) {
        try {
          rmSync(this.#imageDir, { recursive: true, force: true })
        } catch {}
      }
    })
  }

  #scheduleTurn(): void {
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  async #ensureThread(): Promise<AppServerConnection> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    const connection = this.#connection ?? (await this.#connect())
    if (!this.#threadLoaded) {
      await this.#openThread(connection)
      this.#threadLoaded = true
    }
    void this.#refreshSkills(connection)
    return connection
  }

  async #connect(): Promise<AppServerConnection> {
    const connection = this.config.connectFn({ env: this.#childEnv() })
    this.#connection = connection
    this.#threadLoaded = false
    connection.onNotification((method, params) => this.#handleNotification(method, params))
    connection.onRequest((method, params, id) => this.#answerServerRequest(method, params, id))
    connection.onClose((message) => {
      if (this.#connection === connection) {
        this.#connection = undefined
        this.#threadLoaded = false
      }
      this.core.settleAllApprovals({ behavior: 'deny', message }, 'policy')
      this.#agents.sweep()
      this.#activeTurn?.reject(new Error(message))
    })
    try {
      await connection.request('initialize', INITIALIZE_PARAMS)
    } catch (error) {
      // Don't leave a half-initialized child around: the next message must respawn from scratch.
      connection.close()
      if (this.#connection === connection) {
        this.#connection = undefined
      }
      if (error instanceof JsonRpcError) {
        throw new Error(
          'codex app-server rejected initialize (capabilities.experimentalApi: true is required ' +
            'for the granular approval policy, and WorkerDeck has no non-experimental fallback): ' +
            error.message,
          { cause: error },
        )
      }
      throw error
    }
    connection.notify('initialized')
    this.#workspaceWrite = await readWorkspaceWrite(connection, this.#cwd)
    return connection
  }

  async #openThread(connection: AppServerConnection): Promise<void> {
    const policy = modePolicy(this.#permissionMode)
    const options: Record<string, unknown> = {
      cwd: this.#cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: threadSandbox(this.#permissionMode),
      approvalsReviewer: policy.approvalsReviewer,
    }
    if (this.#model) {
      options.model = this.#model
    }
    if (this.#instructions !== undefined) {
      options.developerInstructions = this.#instructions
    }
    const dynamic = sessionToolSpecs(this.toolSources)
    if (dynamic.length) {
      options.dynamicTools = dynamic.map((spec) => ({ type: 'function', ...spec }))
    }
    const mcpServers = codexMcpServers(this.config, await this.#configuredMcpServers(connection))
    if (mcpServers) {
      options.config = { mcp_servers: mcpServers }
    }
    const resuming = this.#resumableThreadId()
    const { result, lostThread } = await this.#resumeOrStart(connection, resuming, options)
    if (typeof result?.thread?.id === 'string') {
      this.#sdkSessionId = result.thread.id
    }
    if (lostThread !== undefined) {
      this.#threadMaterialized = false
      this.core.emit({ type: 'session_error', message: threadLostNotice(lostThread) })
    }
    if (typeof result?.model === 'string') {
      this.#resolvedModel = result.model
    }
    if (typeof result?.reasoningEffort === 'string') {
      this.#resolvedEffort = result.reasoningEffort
    }
    if (!this.#effortExplicit && this.#reasoningEffort === undefined) {
      this.#reasoningEffort = effortDefaultFor(this.config.effortDefaults, CODEX_CATALOG.models, this.#resolvedModel)
    }
    this.#reportEffort()
    if (resuming !== undefined && lostThread === undefined && this.#backfillPending && !this.#resumedHistory) {
      this.#resumedHistory = {
        turns: Array.isArray(result?.thread?.turns) ? result.thread.turns : [],
        partial: typeof result?.turnsBackwardsCursor === 'string',
      }
    }
  }

  async #configuredMcpServers(connection: AppServerConnection): Promise<Set<string>> {
    if (undeclaredFilterServers(this.config).length === 0) {
      return new Set()
    }
    try {
      const result = (await connection.request('mcpServerStatus/list', {})) as AppServerMcpServerStatusResponse
      return new Set((result?.data ?? []).map((server) => server.name))
    } catch {
      return new Set()
    }
  }

  async #resumeOrStart(
    connection: AppServerConnection,
    resuming: string | undefined,
    options: Record<string, unknown>,
  ): Promise<{ result: AppServerThreadResult; lostThread?: string }> {
    if (resuming !== undefined) {
      try {
        return { result: (await connection.request('thread/resume', { threadId: resuming, ...options })) as AppServerThreadResult }
      } catch (error) {
        if (!rolloutMissing(error)) {
          throw error
        }
        return { result: (await connection.request('thread/start', options)) as AppServerThreadResult, lostThread: resuming }
      }
    }
    return { result: (await connection.request('thread/start', options)) as AppServerThreadResult }
  }

  async #refreshSkills(connection: AppServerConnection): Promise<void> {
    if (this.#skillsRefresh) {
      return this.#skillsRefresh
    }
    const run = (async () => {
      try {
        const result = (await connection.request('skills/list', { cwds: [this.#cwd] })) as AppServerSkillsListResponse
        if (this.core.closed) {
          return
        }
        const { skills, paths } = skillCatalog(result)
        this.#skillPaths = paths
        const fingerprint = JSON.stringify(skills)
        if (fingerprint === this.#skillsFingerprint) {
          return
        }
        this.#skillsFingerprint = fingerprint
        this.core.emit({ type: 'skills', skills })
      } catch {
      } finally {
        this.#skillsRefresh = undefined
      }
    })()
    this.#skillsRefresh = run
    return run
  }

  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    if (this.core.closed) {
      return undefined
    }
    const live = this.#connection
    let scratch: AppServerConnection | undefined
    try {
      const connection = live ?? (scratch = await this.#openScratchConnection())
      const threadId = live && this.#threadLoaded ? this.#sdkSessionId : undefined
      const result = (await connection.request('mcpServerStatus/list', threadId ? { threadId } : {})) as AppServerMcpServerStatusResponse
      const servers = (result?.data ?? []).map((server) => mcpServerInfo(server, this.#mcpStatus.get(server.name)))
      if (threadId) {
        return servers
      }
      const listed = new Set(servers.map((server) => server.name))
      const declared = Object.keys(this.config.mcpServers ?? {}).filter((name) => !listed.has(name))
      return [...servers, ...declared.map((name) => ({ name, status: 'pending' }))]
    } catch {
      return undefined
    } finally {
      scratch?.close()
    }
  }

  #emitFileProduced(path: string, toolUseId: string): void {
    if (this.#producedPaths.has(path)) {
      return
    }
    this.#producedPaths.add(path)
    let bytes: number | undefined
    try {
      const stat = statSync(path)
      if (stat.isFile()) {
        bytes = stat.size
      }
    } catch {}
    this.core.emit(fileProducedEvent(path, toolUseId, bytes))
  }

  async #backfillHistory(): Promise<void> {
    try {
      if (this.core.closed) {
        return
      }
      const connection = await this.#ensureThread()
      const resumed = this.#resumedHistory
      this.#resumedHistory = undefined
      const history = await loadHistory(connection, this.#sdkSessionId, resumed)
      if (history.incomplete) {
        this.core.emit({ type: 'session_error', message: incompleteHistoryNotice(history.incomplete) })
      }
      replayTurns(this.#sink, history.turns)
    } catch {
    } finally {
      this.#backfillPending = false
      this.core.setStatus('idle')
    }
  }

  #newTurnState(): { active: ActiveTurn; outcome: Promise<AppServerTurn> } {
    const steerGate = deferred<void>()
    const outcome = deferred<AppServerTurn>()
    const settle = (finish: () => void): void => {
      if (active.settled) {
        return
      }
      active.settled = true
      active.openSteerGate()
      finish()
    }
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
      steerGate: steerGate.promise,
      openSteerGate: () => steerGate.resolve(),
      steerChain: Promise.resolve(),
      resolve: (turn) => settle(() => outcome.resolve(turn)),
      reject: (error) => settle(() => outcome.reject(error)),
    }
    return { active, outcome: outcome.promise }
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
    const startedAt = Date.now()
    const { active, outcome } = this.#newTurnState()
    this.#activeTurn = active
    this.#idleScope = { nonce: active.nonce, toolUseEmitted: new Set(), sectionIndex: new Map() }
    try {
      const connection = await this.#ensureThread()
      // The first turn's input was built before the connection's own skills/list answered.
      if (mentionsSkill(turn.input)) {
        await this.#skillsRefresh
        turn.input = withSkillItems(turn.input, this.#skillPaths)
      }
      const policy = modePolicy(this.#permissionMode)
      const params: Record<string, unknown> = {
        threadId: this.#sdkSessionId,
        input: turn.input,
        cwd: this.#cwd,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: turnSandboxPolicy(this.#permissionMode, this.#workspaceWrite),
        approvalsReviewer: policy.approvalsReviewer,
      }
      const model = this.#model ?? this.#resolvedModel
      if (model) {
        params.model = model
      }
      const effort = this.#reasoningEffort ?? this.#resolvedEffort
      if (effort) {
        params.effort = effort
      }
      // The terminal signal is the `turn/completed` notification; this response's timing is
      // unspecified, so it only contributes the turn id or a failure.
      connection.request('turn/start', params).then(
        (result) => {
          const started = (result as { turn?: AppServerTurn })?.turn
          if (!started) {
            return
          }
          this.#adoptTurnId(active, started.id)
          if (started.status && started.status !== 'inProgress') {
            active.resolve(started)
          }
        },
        (error: unknown) => active.reject(error instanceof Error ? error : new Error(String(error))),
      )
      const result = await outcome
      if (this.core.closed) {
        return
      }
      if (result.status === 'completed') {
        this.#finishTurn('success', startedAt, active)
      } else {
        const reason =
          result.status === 'interrupted'
            ? 'interrupted'
            : (result.error?.message ?? active.lastError ?? 'codex app-server ended the turn without a result')
        this.#finishTurn('failure', startedAt, active, [reason])
      }
    } catch (error) {
      if (this.core.closed) {
        return
      }
      this.#finishTurn('failure', startedAt, active, [active.interrupted ? 'interrupted' : errorMessage(error)])
    } finally {
      if (this.#activeTurn === active) {
        this.#activeTurn = undefined
      }
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (this.core.closed) {
      return
    }
    if (THREAD_SCOPED_NOTIFICATIONS.has(method) && !this.#isRootThread(params)) {
      if (method === 'turn/completed') {
        settleAgentTurn(this.#sink, params)
      } else if (method === 'turn/started') {
        const threadId = threadIdOf(params)
        const record = threadId ? this.#agents.get(threadId) : undefined
        if (record && record.status !== 'running') {
          this.#agents.revive(record)
        }
      }
      return
    }
    this.#notifications[method]?.(params)
  }

  #isRootThread(params: unknown): boolean {
    const threadId = threadIdOf(params)
    if (threadId === undefined) {
      return true
    }
    return threadId === this.#sdkSessionId
  }

  #itemContext(params: unknown): ItemContext | undefined {
    return itemContext(this.#sink, params, {
      activeScope: this.#activeTurn,
      idleScope: this.#idleScope,
      clearedThreads: this.#clearedThreads,
    })
  }

  #reasoningDelta(method: string): (params: unknown) => void {
    return (params) => {
      const context = this.#itemContext(params)
      if (context) {
        reasoningDelta(this.#sink, method, params, context)
      }
    }
  }

  #itemProgress = (params: unknown): void => {
    const context = this.#itemContext(params)
    const item = (params as { item?: AppServerItem })?.item
    if (!context || !item) {
      return
    }
    itemProgress(this.#sink, item, context.scope, context.agent)
  }

  readonly #notifications: Record<string, (params: unknown) => void> = {
    'thread/started': (params) => {
      const thread = (params as { thread?: { id?: string } })?.thread
      if (typeof thread?.id === 'string') {
        this.#sdkSessionId = thread.id
      }
    },
    'turn/started': (params) => {
      this.#threadMaterialized = true
      const active = this.#activeTurn
      const turn = (params as { turn?: AppServerTurn })?.turn
      if (active && turn) {
        this.#adoptTurnId(active, turn.id)
      }
    },
    'turn/completed': (params) => {
      this.#threadMaterialized = true
      const active = this.#activeTurn
      const turn = (params as { turn?: AppServerTurn })?.turn
      if (!active || !turn) {
        return
      }
      if (active.turnId && turn.id && turn.id !== active.turnId) {
        return
      }
      active.resolve(turn)
    },
    'item/started': this.#itemProgress,
    'item/updated': this.#itemProgress,
    'item/completed': (params) => {
      const context = this.#itemContext(params)
      const item = (params as { item?: AppServerItem })?.item
      if (!context || !item) {
        return
      }
      itemCompleted(this.#sink, item, context.scope, context.agent)
    },
    'item/agentMessage/delta': (params) => {
      const context = this.#itemContext(params)
      if (!context) {
        return
      }
      const delta = (params as { delta?: string })?.delta
      if (typeof delta === 'string' && delta) {
        emitDelta(this.#sink, { type: 'text_delta', text: delta }, context.agent?.toolUseId ?? null)
      }
    },
    'item/commandExecution/outputDelta': (params) => {
      const context = this.#itemContext(params)
      const { itemId, delta } = (params ?? {}) as { itemId?: unknown; delta?: unknown }
      if (context && typeof itemId === 'string' && typeof delta === 'string') {
        this.#outputTails.append(`${context.scope.nonce}:${itemId}`, delta)
      }
    },
    'item/reasoning/textDelta': this.#reasoningDelta('item/reasoning/textDelta'),
    'item/reasoning/summaryTextDelta': this.#reasoningDelta('item/reasoning/summaryTextDelta'),
    'thread/tokenUsage/updated': (params) => {
      const active = this.#activeTurn
      if (!active) {
        return
      }
      const last = (params as AppServerTokenUsageUpdate)?.tokenUsage?.last
      if (!last) {
        return
      }
      active.sawUsage = true
      for (const field of TOKEN_FIELDS) {
        active.usage[field] = (active.usage[field] ?? 0) + (last[field] ?? 0)
      }
      const update = params as AppServerTokenUsageUpdate
      active.contextTokens = last.totalTokens ?? undefined
      active.contextWindow = update.tokenUsage?.modelContextWindow ?? undefined
    },
    'mcpServer/startupStatus/updated': (params) => {
      const update = params as AppServerMcpStatusUpdate
      if (typeof update?.name !== 'string') {
        return
      }
      this.#mcpStatus.set(update.name, {
        status: typeof update.status === 'string' ? update.status : 'starting',
        ...(update.error ? { error: update.error } : {}),
        ...(update.failureReason ? { failureReason: update.failureReason } : {}),
      })
    },
    'skills/changed': () => {
      const connection = this.#connection
      if (connection) {
        void this.#refreshSkills(connection)
      }
    },
    'account/rateLimits/updated': (params) => {
      this.#emitRateLimits((params as { rateLimits?: AppServerRateLimits })?.rateLimits)
    },
    'turn/plan/updated': (params) => {
      if (!this.#activeTurn) {
        return
      }
      const items = checklistFromPlan((params as AppServerPlanUpdate)?.plan)
      if (items && !sameChecklist(this.core.log.checklist, items)) {
        this.core.emit({ type: 'checklist', items })
      }
    },
    'serverRequest/resolved': (params) => {
      const requestId = (params as { requestId?: string | number })?.requestId
      if (requestId === undefined) {
        return
      }
      const id = this.core.findApproval((_request, wireId) => wireId === requestId)
      if (id !== undefined) {
        // Reported as a deny because codex's own choice is unknowable; the message says who decided.
        this.core.resolveApproval(id, { behavior: 'deny', message: 'resolved by codex' }, 'policy')
      }
    },
    // Mostly retry noise (`willRetry: true`); the last message is what explains a turn that
    // fails without carrying its own error.
    error: (params) => {
      const active = this.#activeTurn
      const error = (params as { error?: { message?: string } })?.error
      if (active && typeof error?.message === 'string') {
        active.lastError = error.message
      }
    },
  }

  async #answerServerRequest(method: string, params: unknown, wireId?: string | number): Promise<unknown> {
    const channel = APPROVAL_CHANNELS[method]
    if (channel) {
      return this.#requestApproval(channel, method, params, wireId)
    }
    if (method === 'item/tool/call') {
      const call = params as AppServerDynamicToolCallParams
      let args = call.arguments
      if (this.#needsShellWriteCard(call.tool)) {
        const verdict = (await this.#requestApproval(SHELL_WRITE_CHANNEL, method, call, undefined)) as ShellWriteVerdict
        if (!verdict.allowed) {
          return { success: false, contentItems: [{ type: 'inputText', text: shellWriteDeniedText(call.tool, verdict.message) }] }
        }
        args = verdict.updatedInput ?? args
      }
      const output = await runSessionTool(this.toolSources, this.id, call.tool, args)
      if (output) {
        return { success: !output.isError, contentItems: [{ type: 'inputText', text: output.text }] }
      }
    }
    throw new JsonRpcError(-32601, `workerdeck does not handle server request '${method}'`)
  }

  #needsShellWriteCard(tool: string): boolean {
    return (
      this.config.shells !== undefined &&
      isShellToolName(tool) &&
      shellToolNeedsCard(tool, this.config.shellAgentWrite) &&
      SHELL_WRITE_GATE_MODES.has(this.#permissionMode)
    )
  }

  #requestApproval(channel: ApprovalChannel, method: string, params: unknown, wireId: string | number | undefined): Promise<unknown> {
    if (method === 'item/tool/requestUserInput') {
      const behavior = this.config.questionBehavior ?? 'ask'
      if (behavior !== 'ask') {
        return Promise.resolve(this.#resolveQuestionByPolicy(channel, params, behavior))
      }
    }
    const id = randomUUID()
    const { timeoutMs, expiresAt } = this.approvalDeadline()
    const itemId = channel.itemId(params)
    const request: PermissionRequest = {
      id,
      ...channel.describe(params),
      toolUseId: itemId ? `${this.#activeTurn?.nonce ?? 'codex'}:${itemId}` : id,
      expiresAt,
    }
    return new Promise<unknown>((resolve) => {
      const offered = offeredDecisions(params)
      let sent: { response: unknown; decision?: string } | undefined
      this.core.requestApproval(request, {
        timeoutMs,
        wireId,
        respond: (decision, resolvedBy) => {
          const answer = answerApproval(channel, params, offered, decision, resolvedBy)
          sent = answer.sent
          resolve(answer.sent.response)
          return answer.resolution
        },
        after: (resolution, decision) => {
          if (resolution.behavior === 'deny' && decision.behavior === 'deny' && decision.interrupt && sent?.decision !== 'cancel') {
            void this.#interruptTurn()
          }
          if (!this.core.closed && this.core.pendingCount === 0 && this.core.status === 'awaiting_approval') {
            this.core.setStatus('running')
          }
        },
      })
      if (this.#activeTurn) {
        this.core.setStatus('awaiting_approval')
      }
    })
  }

  #resolveQuestionByPolicy(channel: ApprovalChannel, params: unknown, mode: 'auto' | 'deny'): unknown {
    const itemId = channel.itemId(params)
    const request: PermissionRequest = {
      id: randomUUID(),
      ...channel.describe(params),
      toolUseId: itemId ? `${this.#activeTurn?.nonce ?? 'codex'}:${itemId}` : randomUUID(),
    }
    return { answers: this.core.resolveQuestionByPolicy(request, mode) ? recommendedAnswers(params) : {} }
  }

  #finishTurn(kind: 'success' | 'failure', startedAt: number, active: ActiveTurn, errors?: string[]): void {
    this.core.settleAllApprovals({ behavior: 'deny', message: 'Turn ended' }, 'policy')
    this.#numTurns += 1
    const usage = active.sawUsage ? active.usage : undefined
    const wire = usage
      ? {
          input_tokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
          output_tokens: usage.outputTokens + usage.reasoningOutputTokens,
          cache_creation_input_tokens: usage.cacheWriteInputTokens ?? 0,
          cache_read_input_tokens: usage.cachedInputTokens,
        }
      : undefined
    this.core.emitTurnResult({
      startedAt,
      numTurns: this.#numTurns,
      result: kind === 'success' ? (active.finalText ?? '') : undefined,
      errors,
      usage: wire,
      byModel: wire ? { [this.#model ?? this.#resolvedModel ?? 'unknown']: tokenUsageFromWire(wire) } : undefined,
      costs: true,
    })
    this.#emitContextUsage(active)
    this.core.setStatus('idle')
  }

  #emitRateLimits(limits: AppServerRateLimits | undefined | null): void {
    if (!limits) {
      return
    }
    const status = limits.rateLimitReachedType ? 'rejected' : 'allowed'
    for (const window of [limits.primary, limits.secondary]) {
      if (!window || window.usedPercent === null || window.usedPercent === undefined) {
        continue
      }
      this.core.emit({
        type: 'rate_limit',
        info: {
          status,
          rateLimitType: rateLimitWindowName(window.windowDurationMins),
          utilization: window.usedPercent,
          ...(typeof window.resetsAt === 'number' ? { resetsAt: window.resetsAt } : {}),
        },
      })
    }
    if (limits.planType && limits.planType !== this.#planType) {
      this.#planType = limits.planType
      this.core.emit({ type: 'plan_info', subscriptionType: limits.planType })
    }
  }

  protected async reportFacts(): Promise<SessionReportFacts> {
    const active = this.#activeTurn
    const context: LiveContext | undefined =
      active?.contextTokens !== undefined && active.contextWindow
        ? { totalTokens: active.contextTokens, maxTokens: active.contextWindow, measured: 'live' }
        : liveContextFromReading(this.core.log.contextUsage)
    return { vendor: 'openai', context, rateLimits: true }
  }

  #emitContextUsage(active: ActiveTurn): void {
    const totalTokens = active.contextTokens
    const maxTokens = active.contextWindow
    if (totalTokens === undefined || !maxTokens || maxTokens <= 0) {
      return
    }
    this.core.emit({
      type: 'context_usage',
      usage: {
        categories: [],
        totalTokens,
        maxTokens,
        percentage: Math.min(100, (totalTokens / maxTokens) * 100),
        model: this.#model ?? this.#resolvedModel,
      },
    })
  }

  #markReplay(body: SessionEventBody): SessionEventBody {
    return this.#replayingHistory && (body.type === 'assistant_message' || body.type === 'user_message') ? { ...body, replay: true } : body
  }
}
