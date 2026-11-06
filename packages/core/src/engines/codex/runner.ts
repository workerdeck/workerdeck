import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_CAPABILITIES,
  goalActive,
  supportsPermissionMode,
  type GoalInput,
  type GoalSetter,
  type McpServerStatusInfo,
  type PermissionMode,
  type PermissionRequest,
  type SessionEventBody,
  type SessionGoal,
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
import { runSessionTool, sessionToolSpecs, type SessionToolSources } from '../../lib/session-tools.ts'
import { statusLines } from '../../lib/mcp-tool.ts'
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
import {
  GoalsUnsupportedError,
  goalNotice,
  goalRefusal,
  newerThan,
  sameGoal,
  sameGoalIdentity,
  sessionGoal,
  threadGoalOf,
} from './goals.ts'
import { codexChildEnv, INITIALIZE_PARAMS } from './connect.ts'
import {
  asReplay,
  incompleteHistoryNotice,
  loadHistory,
  readThreadTurns,
  replayTurns,
  type HistorySink,
  type ResumedHistory,
} from './history.ts'
import {
  emitDelta,
  producedFileEvent,
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
  AppServerThreadGoal,
  AppServerTokenUsage,
  AppServerTokenUsageUpdate,
  AppServerTurn,
  AppServerUserInput,
} from './types.ts'

const THREAD_SCOPED_NOTIFICATIONS = new Set([
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated',
  'turn/plan/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
])

const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const

export type CodexRunnerConfig = EngineRunnerConfig & {
  connectFn: AppServerConnectFn
  codexHome?: string
  codexPathOverride?: string
  backfillHistory?: boolean
}

type QueuedTurn = { input: AppServerUserInput[] }

type GoalTarget = { connection: AppServerConnection; threadId: string; close?: () => void }

type GoalMark = { createdAt: number; status: AppServerThreadGoal['status'] } | null

const GOAL_CONFIRM_MS = 2000

function sameMark(a: GoalMark, b: GoalMark): boolean {
  return a === null || b === null ? a === b : a.createdAt === b.createdAt && a.status === b.status
}

type OwnGoalSet = { text: string; setBy: GoalSetter; createdAt?: number }

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

// `thread/read` answers this for a thread with no rollout on disk; an existing thread reads without being loaded.
function threadNotLoaded(error: unknown): boolean {
  return error instanceof JsonRpcError && error.code === -32600 && error.message.startsWith('thread not loaded')
}

function codexVersion(result: unknown): string | undefined {
  const agent = (result as { userAgent?: unknown } | null)?.userAgent
  return typeof agent === 'string' ? /^[^/\s]+\/(\S+)/.exec(agent)?.[1] : undefined
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
  finished: Promise<void>
  finish: () => void
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
  #engineVersion: string | undefined
  #permissionMode: PermissionMode
  #reasoningEffort: string | undefined
  #effortExplicit: boolean
  #effort: string | undefined
  #resolvedModel: string | undefined
  #planType: string | undefined
  #resolvedEffort: string | undefined
  #queue: QueuedTurn[] = []
  #steering = 0
  #turnChain: Promise<void> = Promise.resolve()
  #backfill: Promise<void> | undefined
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
  #goalChain: Promise<unknown> = Promise.resolve()
  #goalBusy = 0
  #goalNotes = 0
  #goalSeen: AppServerThreadGoal | undefined
  #goalWaiters = new Set<() => void>()
  #ownGoalSet: OwnGoalSet | undefined
  #goalsOff = false
  #goalsAccepted = new Set<Promise<unknown>>()
  #humanGoalChanges = 0
  #stopping = 0
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
      capabilities: this.#goalsOff ? { ...ENGINE_CAPABILITIES.codex, goals: undefined } : ENGINE_CAPABILITIES.codex,
      model: this.#model ?? this.#resolvedModel,
      ...(this.#currentEffort() !== undefined ? { effort: this.#currentEffort() } : {}),
      permissionMode: this.#permissionMode,
      canBypassPermissions: true,
      engineVersion: this.#engineVersion,
      totalCostUsd: this.core.cost.reportedCostUsd,
      numTurns: this.#numTurns || undefined,
      subagents: this.#agents.list(),
      ...(this.#asleep ? { engineAsleep: true as const } : {}),
    }
  }

  get engineAsleep(): boolean {
    return this.#asleep
  }

  // The next turn reconnects and `thread/resume`s through `#ensureThread`, the same path a crashed child takes. An
  // active goal is paused first: a resume would restart it.
  async sleep(): Promise<SleepResult> {
    const refused = this.#sleepRefusal()
    if (refused) {
      return { ok: false, reason: refused }
    }
    if (this.#asleep) {
      return { ok: true }
    }
    if (goalActive(this.goal)) {
      try {
        await this.#pauseActiveGoal()
      } catch (error) {
        return { ok: false, reason: `could not pause the goal: ${errorMessage(error)}` }
      }
      const again = this.#sleepRefusal()
      if (again) {
        return { ok: false, reason: again }
      }
    }
    this.#sleepNow()
    return { ok: true }
  }

  #sleepNow(): void {
    if (this.#asleep) {
      return
    }
    const connection = this.#connection
    this.#asleep = true
    this.#connection = undefined
    this.#threadLoaded = false
    connection?.close()
    this.core.emit({ type: 'engine_sleep', asleep: true })
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
    if (this.#goalBusy > 0) {
      return 'a goal change is on its way'
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

  backfilled(): Promise<void> {
    return this.#backfill ?? Promise.resolve()
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#turnChain
    }
    this.#started = true
    this.#warnUntrustedProject()
    if (this.config.resume && this.config.backfillHistory !== false) {
      this.#backfillPending = true
      this.#backfill = this.#turnChain.then(() => this.#backfillHistory())
      this.#turnChain = this.#backfill
    } else {
      this.core.setStatus('idle')
    }
    // A passive attach: never the goal pause an explicit sleep makes.
    if (this.config.startAsleep && !this.config.prompt) {
      this.#turnChain = this.#turnChain.then(() => {
        if (!this.#sleepRefusal()) {
          this.#sleepNow()
        }
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
    this.#steering++
    active.steerChain = active.steerChain.then(async () => {
      try {
        await active.steerGate
        await this.#steer(active, input)
      } finally {
        this.#steering--
      }
    })
  }

  // Input queued for a turn of its own, or a steer the app-server has not taken yet.
  pendingInput(): number {
    return this.#queue.length + this.#steering
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

  // Stop pauses an active goal too: an interrupted goal stays active, and the next resume would restart it.
  // A goal change already accepted is waited for, so a set or resume that confirms after Stop is paused too, and an
  // engine turn it starts meanwhile is interrupted on adoption.
  async interrupt(): Promise<void> {
    this.core.settleAllApprovals({ behavior: 'deny', message: 'interrupted', interrupt: true }, 'policy')
    this.#stopping++
    try {
      const active = this.#activeTurn
      const accepted = Promise.allSettled(this.#goalsAccepted)
      const pausing = accepted
        .then(() => (goalActive(this.goal) ? this.#pauseActiveGoal() : undefined))
        .catch((error: unknown) => {
          this.core.emit({ type: 'session_error', message: `could not pause the goal: ${errorMessage(error)}` })
        })
      await this.#interruptTurn()
      await pausing
      if (this.#activeTurn && !this.#activeTurn.interrupted) {
        await this.#interruptTurn()
      }
      await active?.finished
      await this.#engineTurnsFinished()
      await this.#turnChain
    } finally {
      this.#stopping--
    }
  }

  // Accepted at the call, before any await: Stop and the human-first rule see it from the start.
  #acceptGoalChange<T>(by: GoalSetter | undefined, run: () => Promise<T>): Promise<T> {
    if (by?.kind === 'agent' && this.#humanGoalChanges > 0) {
      return Promise.reject(new Error('a human goal change is pending'))
    }
    const human = by?.kind === 'human'
    if (human) {
      this.#humanGoalChanges++
    }
    const change = run().finally(() => {
      this.#goalsAccepted.delete(change)
      if (human) {
        this.#humanGoalChanges--
      }
    })
    this.#goalsAccepted.add(change)
    return change
  }

  setGoal(input: GoalInput, setBy: GoalSetter): Promise<SessionGoal> {
    return this.#acceptGoalChange(setBy, () => this.#setGoalNow(input, setBy))
  }

  clearGoal(by?: GoalSetter): Promise<void> {
    return this.#acceptGoalChange(by, () => this.#clearGoalNow())
  }

  pauseGoal(paused: boolean, by?: GoalSetter): Promise<SessionGoal> {
    return this.#acceptGoalChange(by, () => this.#pauseGoalNow(paused))
  }

  async #setGoalNow(input: GoalInput, setBy: GoalSetter): Promise<SessionGoal> {
    await this.#loadGoalThread()
    return this.#goalOp(async () => {
      const target = this.#loadedGoalTarget()
      const own: OwnGoalSet = { text: input.text, setBy }
      this.#ownGoalSet = own
      const goal = await this.#goalMutation(target, 'thread/goal/set', {
        threadId: target.threadId,
        objective: input.text,
        status: 'active',
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        origin: 'user',
      })
      if (!goal) {
        throw new Error('codex answered the goal change without a goal')
      }
      own.createdAt ??= goal.createdAt
      return this.goal ?? sessionGoal(goal, setBy)
    })
  }

  async #clearGoalNow(): Promise<void> {
    await this.#goalOp(async () => {
      const target = await this.#idleGoalTarget()
      if (!target) {
        this.#applyGoal(null, false)
        return
      }
      await this.#goalMutation(target, 'thread/goal/clear', { threadId: target.threadId, origin: 'user' })
    })
  }

  // Resuming is deliberate work and wakes the engine like a send; pausing never does.
  async #pauseGoalNow(paused: boolean): Promise<SessionGoal> {
    if (!paused) {
      await this.#loadGoalThread()
    }
    return this.#goalOp(async () => {
      const target = paused ? await this.#idleGoalTarget() : this.#loadedGoalTarget()
      if (!target) {
        throw new Error('there is no goal to pause')
      }
      const goal = await this.#goalMutation(target, 'thread/goal/set', {
        threadId: target.threadId,
        status: paused ? 'paused' : 'active',
        origin: 'user',
      })
      if (!goal) {
        throw new Error('codex answered the goal change without a goal')
      }
      return this.goal ?? sessionGoal(goal, this.#selfSetter())
    })
  }

  #pauseActiveGoal(): Promise<void> {
    return this.#goalOp(async () => {
      if (!goalActive(this.goal)) {
        return
      }
      const target = await this.#idleGoalTarget()
      if (target) {
        await this.#goalMutation(target, 'thread/goal/set', { threadId: target.threadId, status: 'paused', origin: 'user' })
      }
    })
  }

  async #goalOp<T>(run: () => Promise<T>): Promise<T> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    this.#goalBusy++
    const op = this.#goalChain.then(run)
    this.#goalChain = op.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await op
    } finally {
      this.#goalBusy--
    }
  }

  // Rides the turn chain like a send: it serialises with clears and backfill, and a resume is the deliberate wake.
  async #loadGoalThread(): Promise<void> {
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    if (this.#connection && this.#threadLoaded && this.#sdkSessionId && this.#clearsPending === 0) {
      return
    }
    this.#wake()
    const link = this.#turnChain.then(() => this.#ensureThread())
    this.#turnChain = link.then(
      () => undefined,
      () => undefined,
    )
    await link
  }

  #loadedGoalTarget(): GoalTarget {
    const connection = this.#connection
    const threadId = this.#sdkSessionId
    if (!connection || !this.#threadLoaded || !threadId) {
      throw new Error('the engine stopped before the goal change reached it')
    }
    return { connection, threadId }
  }

  // Never resumes: a pause or a clear must not restart the goal it stops. An unloaded thread takes the RPC as is.
  async #idleGoalTarget(): Promise<GoalTarget | undefined> {
    if (this.#connection && this.#threadLoaded && this.#sdkSessionId) {
      return { connection: this.#connection, threadId: this.#sdkSessionId }
    }
    const threadId = this.#resumableThreadId()
    if (!threadId) {
      return undefined
    }
    if (this.#connection && !this.#asleep) {
      return { connection: this.#connection, threadId }
    }
    const scratch = await this.#openScratchConnection()
    return { connection: scratch, threadId, close: () => scratch.close() }
  }

  // Notifications can overtake the response they belong to, and stamps cannot order a status change against a tick
  // of the same second. So: a response nothing overtook is applied; one a notification already confirmed is done; a
  // status change notified during the call (the engine moved on) wins; after mere ticks the mutation waits, bounded,
  // for the notification that carries its outcome, and applies the response itself if none comes.
  async #goalMutation(target: GoalTarget, method: string, params: Record<string, unknown>): Promise<AppServerThreadGoal | null> {
    const notes = this.#goalNotes
    const before = this.#goalMark()
    let result: unknown
    try {
      result = await target.connection.request(method, params)
    } catch (error) {
      throw this.#goalRefused(error)
    } finally {
      target.close?.()
    }
    if (this.core.closed) {
      throw new Error('session is closed')
    }
    const goal = method === 'thread/goal/clear' ? null : (threadGoalOf((result as { goal?: unknown } | null)?.goal) ?? null)
    if (method !== 'thread/goal/clear' && !goal) {
      return null
    }
    if (target.threadId !== this.#sdkSessionId) {
      return goal
    }
    const wanted: GoalMark = goal ? { createdAt: goal.createdAt, status: goal.status } : null
    if (notes === this.#goalNotes) {
      this.#applyGoal(goal, false)
      return goal
    }
    if (sameMark(this.#goalMark(), wanted)) {
      return goal
    }
    if (!sameMark(this.#goalMark(), before)) {
      if (goal && this.#goalSeen && newerThan(goal, this.#goalSeen)) {
        this.#applyGoal(goal, false)
      }
      return goal
    }
    if ((await this.#awaitGoalMark(before, wanted)) === 'timeout' && !this.core.closed && target.threadId === this.#sdkSessionId) {
      this.#applyGoal(goal, false)
    }
    return goal
  }

  #goalMark(): GoalMark {
    const seen = this.#goalSeen
    return seen ? { createdAt: seen.createdAt, status: seen.status } : null
  }

  async #awaitGoalMark(before: GoalMark, wanted: GoalMark): Promise<'confirmed' | 'moved' | 'timeout'> {
    const deadline = Date.now() + GOAL_CONFIRM_MS
    for (;;) {
      if (this.core.closed) {
        return 'moved'
      }
      const mark = this.#goalMark()
      if (sameMark(mark, wanted)) {
        return 'confirmed'
      }
      if (!sameMark(mark, before)) {
        return 'moved'
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return 'timeout'
      }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.#goalWaiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, remaining)
        this.#goalWaiters.add(done)
      })
    }
  }

  #goalNoted(): void {
    this.#goalNotes++
    for (const wake of this.#goalWaiters) {
      wake()
    }
  }

  #goalRefused(error: unknown): Error {
    const refusal = goalRefusal(error)
    if (refusal instanceof GoalsUnsupportedError) {
      this.#goalsOff = true
    }
    return refusal
  }

  // Read-only: `thread/goal/get` never starts work. A notification seen meanwhile is newer than this answer.
  async #hydrateGoal(connection: AppServerConnection): Promise<void> {
    const threadId = this.#sdkSessionId
    if (!threadId || this.#goalsOff) {
      return
    }
    const notes = this.#goalNotes
    let result: unknown
    try {
      result = await connection.request('thread/goal/get', { threadId })
    } catch (error) {
      this.#goalRefused(error)
      return
    }
    if (this.core.closed || threadId !== this.#sdkSessionId || notes !== this.#goalNotes) {
      return
    }
    this.#applyGoal(threadGoalOf((result as { goal?: unknown } | null)?.goal) ?? null, true)
  }

  // A `null` tombstone (cleared before this runner existed) lets only an active engine goal through: that one is
  // real work the engine would run, a finished or paused one is the goal that was cleared.
  #applyGoal(next: AppServerThreadGoal | null, quiet: boolean): void {
    if (this.core.closed) {
      return
    }
    const previous = this.goal
    if (next === null) {
      this.#goalSeen = undefined
      if (previous) {
        this.emitGoal(null, quiet ? undefined : 'cleared')
      }
      return
    }
    const own = this.#ownSetFor(next)
    if (!own && next.status !== 'active' && this.core.log.goal === undefined && this.config.goal === null) {
      return
    }
    this.#goalSeen = next
    const setBy = own?.setBy ?? (previous && sameGoalIdentity(previous, next) ? previous.setBy : this.#selfSetter())
    const goal = sessionGoal(next, setBy)
    if (previous && sameGoal(previous, goal)) {
      return
    }
    this.emitGoal(goal, quiet ? undefined : goalNotice(previous, goal))
  }

  #ownSetFor(goal: AppServerThreadGoal): OwnGoalSet | undefined {
    const own = this.#ownGoalSet
    if (!own || own.text !== goal.objective || (own.createdAt !== undefined && own.createdAt !== goal.createdAt)) {
      return undefined
    }
    return own
  }

  // The codex model's own `create_goal`/`update_goal`: codex has no model origin, so anything we did not ask for.
  #selfSetter(): GoalSetter {
    const name = this.config.agent?.name
    return { kind: 'agent', sessionId: this.id, ...(name ? { name } : {}) }
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

  // An active goal is paused first: the old thread stays loaded, and its continuation would arrive as a non-root thread.
  async #clearNow(options?: ClearContextOptions): Promise<void> {
    if (goalActive(this.goal)) {
      try {
        await this.#pauseActiveGoal()
      } catch (error) {
        throw new Error(`could not pause the goal before the cut: ${errorMessage(error)}`, { cause: error })
      }
    }
    await this.#engineTurnsFinished()
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
    this.#ownGoalSet = undefined
    this.#goalSeen = undefined
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
      this.#engineVersion = codexVersion(await connection.request('initialize', INITIALIZE_PARAMS)) ?? this.#engineVersion
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
    const threadConfig: Record<string, unknown> = {
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
      ...(this.config.instructionScope === 'cwd' ? { project_root_markers: [] } : {}),
    }
    if (Object.keys(threadConfig).length > 0) {
      options.config = threadConfig
    }
    const resuming = this.#resumableThreadId()
    const { result, lostThread } = await this.#resumeOrStart(connection, resuming, options)
    if (typeof result?.thread?.id === 'string') {
      this.#sdkSessionId = result.thread.id
    }
    if (lostThread !== undefined) {
      this.#threadMaterialized = false
      this.core.emit({ type: 'session_error', message: threadLostNotice(lostThread) })
      this.#applyGoal(null, true)
    } else if (resuming !== undefined) {
      await this.#hydrateGoal(connection)
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

  protected override get toolSources(): SessionToolSources {
    return { ...super.toolSources, mcp: { list: () => this.mcpServers(), reload: () => this.#reloadMcpServers() } }
  }

  // Codex has no per-server reconnect; its reload re-reads the config layers and refreshes the loaded thread in place.
  async #reloadMcpServers(): Promise<string> {
    const connection = this.#connection
    if (!connection || !this.#threadLoaded) {
      return 'Your engine is not running; it reads its MCP configuration afresh with the next message.'
    }
    await connection.request('config/mcpServer/reload')
    const servers = await this.mcpServers()
    return `MCP configuration reloaded; the servers' tools are available from your next step.\n${statusLines(servers ?? [])}`
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
    this.core.emit(producedFileEvent(path, toolUseId))
  }

  // Never `thread/resume` here: a resume restarts an active goal by itself, and showing history must not start paid work.
  async #backfillHistory(): Promise<void> {
    try {
      if (this.core.closed) {
        return
      }
      const connection = this.#connection ?? (await this.#connect())
      void this.#refreshSkills(connection)
      let turns: AppServerHistoryTurn[]
      let read = true
      try {
        turns = await readThreadTurns(connection, this.#sdkSessionId)
      } catch (error) {
        if (!threadNotLoaded(error)) {
          this.core.emit({ type: 'session_error', message: incompleteHistoryNotice(errorMessage(error)) })
          return
        }
        read = false
        turns = await this.#resumeLostThread()
      }
      replayTurns(this.#sink, turns)
      if (read) {
        await this.#hydrateGoal(connection)
      }
    } catch {
    } finally {
      this.#backfillPending = false
      this.core.setStatus('idle')
    }
  }

  // No rollout behind the id, so no goal to restart: the resume path starts the fresh thread and says so.
  async #resumeLostThread(): Promise<AppServerHistoryTurn[]> {
    const connection = await this.#ensureThread()
    const resumed = this.#resumedHistory
    this.#resumedHistory = undefined
    const history = await loadHistory(connection, this.#sdkSessionId, resumed)
    if (history.incomplete) {
      this.core.emit({ type: 'session_error', message: incompleteHistoryNotice(history.incomplete) })
    }
    return history.turns
  }

  #newTurnState(): { active: ActiveTurn; outcome: Promise<AppServerTurn> } {
    const steerGate = deferred<void>()
    const finished = deferred<void>()
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
      finished: finished.promise,
      finish: () => finished.resolve(),
      steerGate: steerGate.promise,
      openSteerGate: () => steerGate.resolve(),
      steerChain: Promise.resolve(),
      resolve: (turn) => settle(() => outcome.resolve(turn)),
      reject: (error) => settle(() => outcome.reject(error)),
    }
    return { active, outcome: outcome.promise }
  }

  // An engine-started turn finalizes off the chain; whatever the chain runs next waits for it.
  async #engineTurnsFinished(): Promise<void> {
    while (this.#activeTurn) {
      await this.#activeTurn.finished
    }
  }

  async #runTurn(): Promise<void> {
    await this.#engineTurnsFinished()
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
          if (started.status && started.status !== 'inProgress' && started.id === active.turnId) {
            active.resolve(started)
          }
        },
        (error: unknown) => active.reject(error instanceof Error ? error : new Error(String(error))),
      )
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)))
    }
    await this.#settleTurn(active, outcome, startedAt)
  }

  // A goal continuation, or the turn a resume restarts: owned like a sent turn, with no prompt and no echo.
  #adoptEngineTurn(turnId: string): void {
    const { active, outcome } = this.#newTurnState()
    this.#adoptTurnId(active, turnId)
    this.#activeTurn = active
    this.#idleScope = { nonce: active.nonce, toolUseEmitted: new Set(), sectionIndex: new Map() }
    this.core.setStatus('running')
    void this.#settleTurn(active, outcome, Date.now())
    if (this.#stopping > 0) {
      void this.#interruptTurn()
    }
  }

  async #settleTurn(active: ActiveTurn, outcome: Promise<AppServerTurn>, startedAt: number): Promise<void> {
    try {
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
      active.finish()
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
      const turnId = (params as { turn?: AppServerTurn })?.turn?.id
      if (typeof turnId !== 'string' || !turnId) {
        return
      }
      if (active && !active.settled) {
        this.#adoptTurnId(active, turnId)
      } else if (active?.turnId !== turnId) {
        this.#adoptEngineTurn(turnId)
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
    'thread/goal/updated': (params) => {
      const goal = threadGoalOf((params as { goal?: unknown } | null)?.goal)
      if (!goal || goal.threadId !== this.#sdkSessionId) {
        return
      }
      this.#applyGoal(goal, false)
      this.#goalNoted()
    },
    'thread/goal/cleared': () => {
      this.#applyGoal(null, false)
      this.#goalNoted()
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
    const superseded = this.#activeTurn !== undefined && this.#activeTurn !== active
    if (!superseded) {
      this.core.settleAllApprovals({ behavior: 'deny', message: 'Turn ended' }, 'policy')
    }
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
    if (!superseded) {
      this.core.setStatus('idle')
    }
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
    return this.#replayingHistory ? asReplay(body) : body
  }
}
