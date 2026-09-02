import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_CAPABILITIES,
  type ContentBlock,
  type CreateSessionRequest,
  type FilePatch,
  type McpServerStatusInfo,
  type PermissionDecisionSource,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
  type SkillInfo,
  type UserQuestion,
} from '@workerdeck/protocol'
import { attachmentKind, attachmentRef, normalizeMediaType, type AttachmentInput } from '../../lib/attachments.ts'
import { parseUnifiedDiff } from '../../lib/patch.ts'
import type { PermissionDecision, Runner, SessionEventListener } from '../../runner-interface.ts'
import { EventLog } from '../../lib/event-log.ts'
import { SubscriberSet, type SubscribeOptions } from '../../lib/subscribers.ts'
import { sessionTitle, withTitle } from '../../lib/title.ts'
import { codexChildEnv, INITIALIZE_PARAMS } from './connect.ts'
import { JsonRpcError } from './jsonrpc.ts'
import { CodexAgentTracker, type CodexAgent } from './subagents.ts'
import { untrustedProjectNotice } from './trust.ts'
import type {
  AppServerCollabAgentToolCallItem,
  AppServerCommandApprovalParams,
  AppServerConnection,
  AppServerConnectFn,
  AppServerElicitationParams,
  AppServerFileChangeApprovalParams,
  AppServerHistoryTurn,
  AppServerImageGenerationItem,
  AppServerItem,
  AppServerMcpServerStatus,
  AppServerMcpServerStatusResponse,
  AppServerMcpStatusUpdate,
  AppServerPermissionsApprovalParams,
  AppServerPlanUpdate,
  AppServerRateLimits,
  AppServerSkillMetadata,
  AppServerSkillsListResponse,
  AppServerTokenUsage,
  AppServerTokenUsageUpdate,
  AppServerTurn,
  AppServerUnknownItem,
  AppServerUserInput,
  AppServerUserInputParams,
  AppServerUserInputQuestion,
  AppServerUserMessageItem,
} from './types.ts'

const THREAD_SANDBOX_BY_MODE: Partial<Record<PermissionMode, string>> = {
  default: 'read-only',
  acceptEdits: 'workspace-write',
  auto: 'workspace-write',
  bypassPermissions: 'danger-full-access',
}

// Only `#turnSandboxPolicy` may send the workspaceWrite entry: every unstated field of that
// variant is serde-defaulted, so a bare object resets the operator's networkAccess and
// writableRoots on every turn.
const TURN_SANDBOX_BY_MODE: Partial<Record<PermissionMode, { type: string }>> = {
  default: { type: 'readOnly' },
  acceptEdits: { type: 'workspaceWrite' },
  auto: { type: 'workspaceWrite' },
  bypassPermissions: { type: 'dangerFullAccess' },
}

type CodexWorkspaceWrite = {
  writableRoots: string[]
  networkAccess: boolean
  excludeTmpdirEnvVar: boolean
  excludeSlashTmp: boolean
}

const GRANULAR_ASK = {
  granular: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
    request_permissions: true,
    skill_approval: true,
  },
}
const GRANULAR_NEVER = {
  granular: {
    sandbox_approval: false,
    rules: false,
    mcp_elicitations: false,
    request_permissions: false,
    skill_approval: false,
  },
}
const THREAD_SCOPED_NOTIFICATIONS = new Set(['turn/started', 'turn/completed', 'thread/tokenUsage/updated'])

const APPROVAL_POLICY_BY_MODE: Partial<Record<PermissionMode, object>> = {
  default: GRANULAR_ASK,
  acceptEdits: GRANULAR_ASK,
  auto: GRANULAR_ASK,
  bypassPermissions: GRANULAR_NEVER,
}

const APPROVALS_REVIEWER_BY_MODE: Partial<Record<PermissionMode, string>> = {
  default: 'user',
  acceptEdits: 'user',
  auto: 'auto_review',
  bypassPermissions: 'user',
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

export const CODEX_IMAGE_TOOL = 'CodexImageGeneration'

export const CODEX_AGENT_TOOL = 'CodexAgent'

export const CODEX_COLLAB_TOOL = 'CodexCollab'

function agentName(agentPath: string | null | undefined): string | undefined {
  if (typeof agentPath !== 'string') {
    return undefined
  }
  const name = agentPath.split('/').filter(Boolean).at(-1)
  return name || undefined
}

function collabInput(item: AppServerCollabAgentToolCallItem): Record<string, unknown> {
  return {
    tool: item.tool,
    ...(item.receiverThreadIds?.length ? { receiverThreadIds: item.receiverThreadIds } : {}),
    ...(item.prompt ? { prompt: item.prompt } : {}),
    ...(item.model ? { model: item.model } : {}),
  }
}

function turnReport(turn: AppServerTurn): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : []
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
      return item.text
    }
  }
  return undefined
}

const MAX_IMAGE_RESULT_CHARS = 512

function shortResult(result: string): boolean {
  return result.length > 0 && result.length <= MAX_IMAGE_RESULT_CHARS && !result.startsWith('data:')
}

function producedFileId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32)
}

const PRODUCED_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

function producedMediaType(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return PRODUCED_MEDIA_TYPES[extension]
}

function skillInfo(skill: AppServerSkillMetadata): SkillInfo {
  return {
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...((skill.interface?.shortDescription ?? skill.shortDescription)
      ? { shortDescription: skill.interface?.shortDescription ?? skill.shortDescription }
      : {}),
    ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
    ...(skill.interface?.defaultPrompt ? { defaultPrompt: skill.interface.defaultPrompt } : {}),
    ...(skill.scope ? { scope: skill.scope } : {}),
    // Codex omits `enabled` for a skill it considers live; defaulting to false would hide it.
    enabled: skill.enabled !== false,
  }
}

function mcpStatusOf(
  authStatus: string | undefined,
  update: { status: string; failureReason?: string } | undefined,
  hasTools: boolean,
): string {
  if (update?.status === 'failed') {
    return update.failureReason === 'reauthenticationRequired' ? 'needs-auth' : 'failed'
  }
  if (update?.status === 'cancelled') {
    return 'failed'
  }
  if (authStatus === 'notLoggedIn') {
    return 'needs-auth'
  }
  if (update?.status === 'ready') {
    return 'connected'
  }
  if (hasTools) {
    return 'connected'
  }
  return 'pending'
}

function mcpServerInfo(
  server: AppServerMcpServerStatus,
  update: { status: string; error?: string; failureReason?: string } | undefined,
): McpServerStatusInfo {
  const tools = Object.entries(server.tools ?? {}).flatMap(([key, tool]) => {
    if (!tool) {
      return []
    }
    const annotations = tool.annotations
    return [
      {
        name: tool.name ?? key,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(annotations
          ? {
              annotations: {
                ...(annotations.readOnlyHint != null ? { readOnly: annotations.readOnlyHint } : {}),
                ...(annotations.destructiveHint != null ? { destructive: annotations.destructiveHint } : {}),
                ...(annotations.openWorldHint != null ? { openWorld: annotations.openWorldHint } : {}),
              },
            }
          : {}),
      },
    ]
  })
  return {
    name: server.name,
    status: mcpStatusOf(server.authStatus ?? undefined, update, tools.length > 0),
    ...(update?.error ? { error: update.error } : {}),
    ...(server.serverInfo?.name ? { serverInfo: { name: server.serverInfo.name, version: server.serverInfo.version ?? '' } } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

function imageGenerationInput(item: AppServerImageGenerationItem): Record<string, unknown> {
  return {
    ...(item.revisedPrompt ? { prompt: item.revisedPrompt } : {}),
    ...(item.savedPath ? { savedPath: item.savedPath } : {}),
  }
}

function offeredDecisions(params: unknown): Set<string> | undefined {
  const raw = (params as { availableDecisions?: unknown })?.availableDecisions
  if (!Array.isArray(raw)) {
    return undefined
  }
  const names = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string') {
      names.add(entry)
    } else if (entry && typeof entry === 'object') {
      for (const key of Object.keys(entry)) {
        names.add(key)
      }
    }
  }
  return names.size > 0 ? names : undefined
}

function pickDecision(behavior: 'allow' | 'deny', interrupt: boolean, offered: Set<string> | undefined): string | undefined {
  const has = (name: string) => !offered || offered.has(name)
  if (behavior === 'allow') {
    return has('accept') ? 'accept' : undefined
  }
  if (interrupt && has('cancel')) {
    return 'cancel'
  }
  return 'decline'
}

function userQuestionsFromCodex(questions: readonly AppServerUserInputQuestion[]): UserQuestion[] {
  return questions.map((question) => ({
    question: question.question,
    header: question.header ?? '',
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
    })),
  }))
}

function historyUserText(item: AppServerUserMessageItem): string {
  if (!Array.isArray(item.content)) {
    return ''
  }
  let images = 0
  const text = item.content
    .map((part) => {
      const candidate = part as { type?: string; text?: unknown } | null
      if (candidate?.type === 'text' && typeof candidate.text === 'string') {
        return candidate.text
      }
      if (typeof candidate?.type === 'string' && candidate.type.toLowerCase().includes('image')) {
        images += 1
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
  if (text) {
    return text
  }
  return images > 0 ? `[${images === 1 ? 'image' : `${images} images`}]` : ''
}

function codexAnswers(
  questions: readonly AppServerUserInputQuestion[],
  answers: Record<string, unknown> | undefined,
): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {}
  for (const question of questions) {
    const value = answers?.[question.question] ?? answers?.[question.id]
    if (typeof value === 'string' && value.length > 0) {
      out[question.id] = { answers: [value] }
    }
  }
  return out
}

type ApprovalSurface = Pick<PermissionRequest, 'toolName' | 'input' | 'title' | 'displayName' | 'description' | 'decisionReason'>

type ApprovalChannel = {
  describe(params: unknown): ApprovalSurface
  itemId(params: unknown): string | undefined
  allow(
    params: unknown,
    updatedInput: Record<string, unknown> | undefined,
    offered: Set<string> | undefined,
  ): { response: unknown; decision?: string } | undefined
  deny(params: unknown, interrupt: boolean, offered: Set<string> | undefined): { response: unknown; decision?: string }
}

function decisionChannel(describe: (params: unknown) => ApprovalSurface, itemId: (params: unknown) => string | undefined): ApprovalChannel {
  return {
    describe,
    itemId,
    allow: (_params, _updatedInput, offered) => {
      const decision = pickDecision('allow', false, offered)
      return decision ? { response: { decision }, decision } : undefined
    },
    deny: (_params, interrupt, offered) => {
      const decision = pickDecision('deny', interrupt, offered)!
      return { response: { decision }, decision }
    },
  }
}

const APPROVAL_CHANNELS: Record<string, ApprovalChannel> = {
  'item/commandExecution/requestApproval': decisionChannel(
    (raw) => {
      const params = raw as AppServerCommandApprovalParams
      const command = params.command ?? undefined
      return {
        toolName: 'CodexCommand',
        input: {
          ...(command !== undefined ? { command } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
        title: params.reason ?? (command ? `Codex wants to run: ${command}` : 'Codex wants to run a command'),
        displayName: 'Run command',
        description: params.reason && command ? command : (params.cwd ?? undefined),
        decisionReason: params.reason ?? undefined,
      }
    },
    (raw) => (raw as AppServerCommandApprovalParams).itemId,
  ),
  'item/fileChange/requestApproval': decisionChannel(
    (raw) => {
      const params = raw as AppServerFileChangeApprovalParams
      return {
        toolName: 'CodexFileChange',
        input: {
          ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
        title: params.reason ?? 'Codex wants to apply file changes',
        displayName: 'Apply file changes',
        description: params.grantRoot ? `write access under ${params.grantRoot}` : undefined,
        decisionReason: params.reason ?? undefined,
      }
    },
    (raw) => (raw as AppServerFileChangeApprovalParams).itemId,
  ),
  'item/permissions/requestApproval': {
    describe: (raw) => {
      const params = raw as AppServerPermissionsApprovalParams
      return {
        toolName: 'CodexPermissions',
        input: {
          ...(params.permissions ? { permissions: params.permissions } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
        title: params.reason ?? 'Codex requests additional permissions',
        displayName: 'Grant permissions',
        description: undefined,
        decisionReason: params.reason ?? undefined,
      }
    },
    itemId: (raw) => (raw as AppServerPermissionsApprovalParams).itemId,
    allow: (raw, updatedInput) => ({
      response: {
        permissions:
          (updatedInput?.permissions as Record<string, unknown> | undefined) ??
          (raw as AppServerPermissionsApprovalParams).permissions ??
          {},
      },
    }),
    deny: () => ({ response: { permissions: {} } }),
  },
  'item/tool/requestUserInput': {
    describe: (raw) => ({
      toolName: 'AskUserQuestion',
      input: {
        questions: userQuestionsFromCodex((raw as AppServerUserInputParams).questions ?? []),
      },
      title: 'Codex asks a question',
      displayName: 'Answer questions',
      description: undefined,
      decisionReason: undefined,
    }),
    itemId: (raw) => (raw as AppServerUserInputParams).itemId,
    allow: (raw, updatedInput) => ({
      response: {
        answers: codexAnswers(
          (raw as AppServerUserInputParams).questions ?? [],
          updatedInput?.answers as Record<string, unknown> | undefined,
        ),
      },
    }),
    deny: () => ({ response: { answers: {} } }),
  },
  'mcpServer/elicitation/request': {
    describe: (raw) => {
      const params = raw as AppServerElicitationParams
      return {
        toolName: 'CodexMcpElicitation',
        input: {
          ...(params.serverName ? { serverName: params.serverName } : {}),
          ...(params.message ? { message: params.message } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
          ...(params.requestedSchema !== undefined ? { requestedSchema: params.requestedSchema } : {}),
          ...(params.url ? { url: params.url } : {}),
        },
        title: params.serverName ? `MCP server '${params.serverName}' requests input` : 'An MCP server requests input',
        displayName: 'MCP elicitation',
        description: params.message ?? undefined,
        decisionReason: undefined,
      }
    },
    itemId: () => undefined,
    allow: (_raw, updatedInput) => ({
      response: {
        action: 'accept',
        ...(updatedInput !== undefined ? { content: updatedInput } : {}),
      },
    }),
    deny: (_raw, interrupt) => ({ response: { action: interrupt ? 'cancel' : 'decline' } }),
  },
}

type PendingCodexApproval = {
  request: PermissionRequest
  channel: ApprovalChannel
  params: unknown
  offered: Set<string> | undefined
  wireId: string | number | undefined
  timer: ReturnType<typeof setTimeout>
  respond: (response: unknown) => void
}

export type CodexRunnerConfig = CreateSessionRequest & {
  connectFn: AppServerConnectFn
  env?: Record<string, string | undefined>
  codexHome?: string
  defaultApprovalTimeoutMs?: number
  backfillHistory?: boolean
}

type QueuedTurn = { input: AppServerUserInput[] }

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

type ActiveTurn = {
  nonce: string
  turnId?: string
  interrupted: boolean
  finalText?: string
  lastError?: string
  usage: AppServerTokenUsage
  sawUsage: boolean
  contextTokens?: number
  contextWindow?: number
  toolUseEmitted: Set<string>
  sectionIndex: Map<string, number>
  settled: boolean
  resolve: (outcome: AppServerTurn) => void
  reject: (error: Error) => void
}

export class CodexRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: CodexRunnerConfig
  readonly #cwd: string
  #log = new EventLog()
  #subscribers = new SubscriberSet()
  #status: SessionStatus = 'starting'
  #statusDetail: string | undefined
  #sdkSessionId: string | undefined
  #model: string | undefined
  #permissionMode: PermissionMode
  #reasoningEffort: string | undefined
  #resolvedModel: string | undefined
  #planType: string | undefined
  #resolvedEffort: string | undefined
  #queue: QueuedTurn[] = []
  #turnChain: Promise<void> = Promise.resolve()
  #activeTurn: ActiveTurn | undefined
  #connection: AppServerConnection | undefined
  #workspaceWrite: CodexWorkspaceWrite | undefined
  #threadLoaded = false
  #numTurns = 0
  #totalCostUsd: number | undefined
  #started = false
  #closed = false
  #imageDir: string | undefined
  #approvals = new Map<string, PendingCodexApproval>()
  #backfillPending = false
  #resumedHistory: { turns: AppServerHistoryTurn[]; partial: boolean } | undefined
  #replayingHistory = false
  #skillsFingerprint: string | undefined
  #skillsRefresh: Promise<void> | undefined
  #producedPaths = new Set<string>()
  #mcpStatus = new Map<string, { status: string; error?: string; failureReason?: string }>()
  #agents = new CodexAgentTracker()
  #clearedThreads = new Set<string>()

  constructor(config: CodexRunnerConfig, id: string = randomUUID()) {
    const mode = config.permissionMode ?? 'default'
    if (!ENGINE_CAPABILITIES.codex.permissionModes.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the codex engine`)
    }
    if (config.forkSession) {
      throw new Error('the codex engine cannot fork a resumed thread')
    }
    if (!config.cwd) {
      throw new Error('the codex engine requires a cwd')
    }
    this.#cwd = config.cwd
    this.#config = config
    this.#permissionMode = mode
    this.#model = config.model
    this.#reasoningEffort = config.reasoningEffort
    this.#sdkSessionId = config.resume
    this.id = id
    this.createdAt = Date.now()
  }

  #childEnv(): Record<string, string> {
    return codexChildEnv(this.#config.env ?? process.env, this.#config.codexHome)
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

  get pendingApprovals(): PermissionRequest[] {
    return [...this.#approvals.values()].map((pending) => pending.request)
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.#cwd,
      profile: this.#config.profile,
      engine: 'codex',
      capabilities: ENGINE_CAPABILITIES.codex,
      model: this.#model ?? this.#resolvedModel,
      permissionMode: this.#permissionMode,
      canBypassPermissions: true,
      createdAt: this.createdAt,
      lastSeq: this.#log.seq,
      activityCount: this.#log.activityCount,
      proseCount: this.#log.proseCount,
      contextUsage: this.#log.contextUsage,
      pendingPermissionCount: this.#approvals.size,
      meta: this.#config.meta,
      scope: this.#config.scope,
      title: sessionTitle(this.#config),
      totalCostUsd: this.#totalCostUsd,
      numTurns: this.#numTurns || undefined,
      lastActivityAt: this.#log.lastActivityAt,
      subagents: this.#agents.list(),
    }
  }

  setTitle(title: string | undefined): void {
    this.#config = withTitle(this.#config, title)
  }

  start(): Promise<void> {
    if (this.#started) {
      return this.#turnChain
    }
    this.#started = true
    this.#warnUntrustedProject()
    if (this.#config.resume && this.#config.backfillHistory !== false) {
      this.#backfillPending = true
      this.#turnChain = this.#turnChain.then(() => this.#backfillHistory())
    } else {
      this.#setStatus('idle')
    }
    if (this.#config.prompt) {
      this.sendMessage(this.#config.prompt)
    }
    if (!this.#config.prompt && !this.#config.resume) {
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
        this.#emit({ type: 'session_error', message })
      }
    } catch {}
  }

  async #probeSkills(): Promise<void> {
    let connection: AppServerConnection | undefined
    try {
      connection = await this.#openScratchConnection()
      if (this.#closed) {
        return
      }
      await this.#refreshSkills(connection)
    } catch {
    } finally {
      connection?.close()
    }
  }

  async #openScratchConnection(): Promise<AppServerConnection> {
    const connection = this.#config.connectFn({ env: this.#childEnv() })
    try {
      await connection.request('initialize', INITIALIZE_PARAMS)
      connection.notify('initialized')
      return connection
    } catch (error) {
      connection.close()
      throw error
    }
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#closed) {
      throw new Error('session is closed')
    }
    if (text.trim() === '/clear' && !attachments?.length) {
      void this.clearContext().catch((error: unknown) => {
        this.#emit({
          type: 'session_error',
          message: `could not clear the conversation: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
      return
    }
    const input = this.#buildInput(text, attachments ?? [])
    const echo = () =>
      this.#emit({
        type: 'user_message',
        message: { role: 'user', content: text },
        parentToolUseId: null,
        attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
        uuid: randomUUID(),
      })
    if (this.#backfillPending) {
      this.#turnChain = this.#turnChain.then(echo)
    } else {
      echo()
    }
    this.#queue.push({ input })
    this.#scheduleTurn()
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
    return parts
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#approvals.get(requestId)
    if (!pending) {
      return false
    }
    this.#settleApproval(requestId, pending, decision, 'client')
    return true
  }

  async interrupt(): Promise<void> {
    for (const [id, pending] of this.#approvals) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'interrupted', interrupt: true }, 'policy')
    }
    await this.#interruptTurn()
    await this.#turnChain
  }

  async clearContext(): Promise<void> {
    if (this.#closed) {
      throw new Error('session is closed')
    }
    const run = this.#turnChain.then(() => this.#clearNow())
    this.#turnChain = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  async #clearNow(): Promise<void> {
    if (this.#closed) {
      throw new Error('session is closed')
    }
    const previousThread = this.#sdkSessionId
    this.#sdkSessionId = undefined
    this.#threadLoaded = false
    if (this.#connection) {
      try {
        await this.#ensureThread()
      } catch (error) {
        this.#sdkSessionId = previousThread
        this.#threadLoaded = false
        throw error
      }
    }
    for (const agent of this.#agents.threadIds()) {
      this.#clearedThreads.add(agent)
    }
    this.#agents.forget()
    for (const [id, pending] of this.#approvals) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'the conversation was cleared' }, 'policy')
    }
    this.#resumedHistory = undefined
    this.#emit({ type: 'conversation_reset', sdkSessionId: this.#sdkSessionId })
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
        // No turn id yet: nothing to address the interrupt to, so end the child. The thread
        // survives on disk and the next message respawns into it.
        connection.close()
        if (this.#connection === connection) {
          this.#connection = undefined
        }
        active.reject(new Error('interrupted'))
      }
    }
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
    this.#queue.length = 0
    for (const [id, pending] of this.#approvals) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'Session closed' }, 'policy')
    }
    this.#connection?.close()
    this.#connection = undefined
    this.#agents.sweep()
    this.#activeTurn?.reject(new Error('session closed'))
    if (this.#imageDir) {
      try {
        rmSync(this.#imageDir, { recursive: true, force: true })
      } catch {}
    }
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
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

  async #readWorkspaceWrite(connection: AppServerConnection): Promise<void> {
    this.#workspaceWrite = undefined
    try {
      const result = (await connection.request('config/read', { cwd: this.#cwd })) as {
        config?: { sandbox_workspace_write?: Record<string, unknown> | null } | null
      }
      const block = result?.config?.sandbox_workspace_write
      if (!block) {
        return
      }
      const roots = block.writable_roots
      this.#workspaceWrite = {
        writableRoots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [],
        networkAccess: block.network_access === true,
        excludeTmpdirEnvVar: block.exclude_tmpdir_env_var === true,
        excludeSlashTmp: block.exclude_slash_tmp === true,
      }
    } catch {}
  }

  #turnSandboxPolicy(): { type: string } | undefined {
    const policy = TURN_SANDBOX_BY_MODE[this.#permissionMode]
    if (policy?.type !== 'workspaceWrite' || !this.#workspaceWrite) {
      return policy
    }
    return { type: 'workspaceWrite', ...this.#workspaceWrite }
  }

  async #ensureThread(): Promise<AppServerConnection> {
    if (this.#closed) {
      throw new Error('session is closed')
    }
    let connection = this.#connection
    if (!connection) {
      connection = this.#config.connectFn({ env: this.#childEnv() })
      this.#connection = connection
      this.#threadLoaded = false
      connection.onNotification((method, params) => this.#handleNotification(method, params))
      connection.onRequest((method, params, id) => this.#answerServerRequest(method, params, id))
      connection.onClose((message) => {
        if (this.#connection === connection) {
          this.#connection = undefined
          this.#threadLoaded = false
        }
        for (const [id, pending] of this.#approvals) {
          this.#settleApproval(id, pending, { behavior: 'deny', message }, 'policy')
        }
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
            'codex app-server rejected initialize (capabilities.experimentalApi: true — required ' +
              'for the granular approval policy, and WorkerDeck has no non-experimental fallback): ' +
              error.message,
            { cause: error },
          )
        }
        throw error
      }
      connection.notify('initialized')
      await this.#readWorkspaceWrite(connection)
    }
    if (!this.#threadLoaded) {
      const options: Record<string, unknown> = {
        cwd: this.#cwd,
        approvalPolicy: APPROVAL_POLICY_BY_MODE[this.#permissionMode],
        sandbox: THREAD_SANDBOX_BY_MODE[this.#permissionMode],
        approvalsReviewer: APPROVALS_REVIEWER_BY_MODE[this.#permissionMode],
      }
      if (this.#model) {
        options.model = this.#model
      }
      const resuming = this.#sdkSessionId !== undefined
      const result = (
        resuming
          ? await connection.request('thread/resume', { threadId: this.#sdkSessionId, ...options })
          : await connection.request('thread/start', options)
      ) as {
        thread?: { id?: string; turns?: AppServerHistoryTurn[] }
        model?: string | null
        reasoningEffort?: string | null
        turnsBackwardsCursor?: string | null
      }
      if (typeof result?.thread?.id === 'string') {
        this.#sdkSessionId = result.thread.id
      }
      if (typeof result?.model === 'string') {
        this.#resolvedModel = result.model
      }
      if (typeof result?.reasoningEffort === 'string') {
        this.#resolvedEffort = result.reasoningEffort
      }
      if (resuming && this.#backfillPending && !this.#resumedHistory) {
        this.#resumedHistory = {
          turns: Array.isArray(result?.thread?.turns) ? result.thread.turns : [],
          partial: typeof result?.turnsBackwardsCursor === 'string',
        }
      }
      this.#threadLoaded = true
    }
    void this.#refreshSkills(connection)
    return connection
  }

  async #refreshSkills(connection: AppServerConnection): Promise<void> {
    if (this.#skillsRefresh) {
      return this.#skillsRefresh
    }
    const run = (async () => {
      try {
        const result = (await connection.request('skills/list', {
          cwds: [this.#cwd],
        })) as AppServerSkillsListResponse
        if (this.#closed) {
          return
        }
        const entries = Array.isArray(result?.data) ? result.data : []
        const seen = new Set<string>()
        const skills: SkillInfo[] = []
        for (const entry of entries) {
          for (const skill of entry?.skills ?? []) {
            if (typeof skill?.name !== 'string' || seen.has(skill.name)) {
              continue
            }
            seen.add(skill.name)
            skills.push(skillInfo(skill))
          }
        }
        skills.sort((a, b) => a.name.localeCompare(b.name))
        const fingerprint = JSON.stringify(skills)
        if (fingerprint === this.#skillsFingerprint) {
          return
        }
        this.#skillsFingerprint = fingerprint
        this.#emit({ type: 'skills', skills })
      } catch {
      } finally {
        this.#skillsRefresh = undefined
      }
    })()
    this.#skillsRefresh = run
    return run
  }

  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    if (this.#closed) {
      return undefined
    }
    const live = this.#connection
    let scratch: AppServerConnection | undefined
    try {
      const connection = live ?? (scratch = await this.#openScratchConnection())
      const result = (await connection.request('mcpServerStatus/list', {})) as AppServerMcpServerStatusResponse
      return (result?.data ?? []).map((server) => mcpServerInfo(server, this.#mcpStatus.get(server.name)))
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
    this.#emit({
      type: 'file_produced',
      fileId: producedFileId(path),
      path,
      ...(producedMediaType(path) ? { mediaType: producedMediaType(path) } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      toolUseId,
    })
  }

  async #backfillHistory(): Promise<void> {
    try {
      if (this.#closed) {
        return
      }
      const connection = await this.#ensureThread()
      const resumed = this.#resumedHistory
      this.#resumedHistory = undefined
      let turns = resumed?.turns ?? []
      let partialReason: string | undefined
      if (resumed?.partial) {
        try {
          const read = (await connection.request('thread/read', {
            threadId: this.#sdkSessionId,
            includeTurns: true,
          })) as { thread?: { turns?: AppServerHistoryTurn[] } }
          const full = read?.thread?.turns
          if (Array.isArray(full) && full.length >= turns.length) {
            turns = full
          } else {
            partialReason = 'thread/read returned less history than the resume page'
          }
        } catch (error) {
          partialReason = error instanceof Error ? error.message : String(error)
        }
      }
      if (partialReason) {
        this.#emit({
          type: 'session_error',
          message: `Resumed thread history is incomplete — older turns could not be loaded (${partialReason})`,
        })
      }
      this.#replayTurns(turns)
    } catch {
    } finally {
      this.#backfillPending = false
      this.#setStatus('idle')
    }
  }

  #replayTurns(turns: readonly AppServerHistoryTurn[]): void {
    for (const turn of turns) {
      if (this.#closed) {
        return
      }
      const state = this.#newTurnState()
      this.#replayingHistory = true
      try {
        for (const item of turn.items ?? []) {
          if (item.type === 'userMessage') {
            const text = historyUserText(item)
            if (!text) {
              continue
            }
            this.#emit({
              type: 'user_message',
              message: { role: 'user', content: text },
              parentToolUseId: null,
              uuid: `${state.nonce}:${item.id}`,
            })
            continue
          }
          this.#handleItemCompleted(item, state)
        }
      } finally {
        this.#replayingHistory = false
      }
    }
  }

  #newTurnState(): ActiveTurn {
    return {
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
  }

  async #runTurn(): Promise<void> {
    if (this.#closed) {
      return
    }
    const turn = this.#queue.shift()
    if (!turn) {
      return
    }
    this.#setStatus('running')
    const startedAt = Date.now()
    const active: ActiveTurn = this.#newTurnState()
    const outcome = new Promise<AppServerTurn>((resolve, reject) => {
      active.resolve = (turnResult) => {
        if (active.settled) {
          return
        }
        active.settled = true
        resolve(turnResult)
      }
      active.reject = (error) => {
        if (active.settled) {
          return
        }
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
        cwd: this.#cwd,
        approvalPolicy: APPROVAL_POLICY_BY_MODE[this.#permissionMode],
        sandboxPolicy: this.#turnSandboxPolicy(),
        approvalsReviewer: APPROVALS_REVIEWER_BY_MODE[this.#permissionMode],
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
          active.turnId ??= started.id
          if (started.status && started.status !== 'inProgress') {
            active.resolve(started)
          }
        },
        (error: unknown) => active.reject(error instanceof Error ? error : new Error(String(error))),
      )
      const result = await outcome
      if (this.#closed) {
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
      if (this.#closed) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.#finishTurn('failure', startedAt, active, [active.interrupted ? 'interrupted' : message])
    } finally {
      if (this.#activeTurn === active) {
        this.#activeTurn = undefined
      }
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (this.#closed) {
      return
    }
    if (THREAD_SCOPED_NOTIFICATIONS.has(method) && !this.#isRootThread(params)) {
      if (method === 'turn/completed') {
        this.#settleAgentTurn(params)
      } else if (method === 'turn/started') {
        const threadId = this.#threadIdOf(params)
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
    const threadId = this.#threadIdOf(params)
    if (threadId === undefined) {
      return true
    }
    return threadId === this.#sdkSessionId
  }

  #threadIdOf(params: unknown): string | undefined {
    const threadId = (params as { threadId?: unknown })?.threadId
    return typeof threadId === 'string' ? threadId : undefined
  }

  #agentFor(params: unknown): CodexAgent | undefined {
    const threadId = this.#threadIdOf(params)
    if (threadId === undefined || threadId === this.#sdkSessionId) {
      return undefined
    }
    const known = this.#agents.get(threadId)
    if (known) {
      return known
    }
    if (this.#clearedThreads.has(threadId)) {
      return undefined
    }
    const nonce = this.#activeTurn?.nonce ?? 'codex'
    const record = this.#agents.open(threadId, `${nonce}:agent:${threadId}`, undefined, Date.now())
    record.anchored = true
    this.#emitToolUse(record.toolUseId, CODEX_AGENT_TOOL, { agentThreadId: threadId })
    return record
  }

  #settleAgentTurn(params: unknown): void {
    const threadId = this.#threadIdOf(params)
    const record = threadId ? this.#agents.get(threadId) : undefined
    if (!record || record.status !== 'running') {
      return
    }
    const turn = (params as { turn?: AppServerTurn })?.turn
    const status = turn?.status === 'completed' ? 'done' : 'failed'
    this.#agents.settle(record, status)
    const report = (turn ? turnReport(turn) : undefined) ?? turn?.error?.message ?? (status === 'done' ? '' : (turn?.status ?? 'failed'))
    this.#emitToolResult(record.toolUseId, report, status === 'failed')
  }

  #reasoningDelta(method: string): (params: unknown) => void {
    return (params) => {
      const active = this.#activeTurn
      if (!active) {
        return
      }
      const payload = params as {
        delta?: string
        itemId?: string
        contentIndex?: number
        summaryIndex?: number
      }
      if (typeof payload?.delta !== 'string' || !payload.delta) {
        return
      }
      const index = payload.contentIndex ?? payload.summaryIndex ?? 0
      const agent = this.#agentFor(params)
      // Both the agent and the method ride the key. sectionIndex lives on the root turn, and whether
      // app-server item ids are unique across a turn's threads is unverified (docs/GOTCHAS.md
      // §Codex), so two agents must not be able to share a section counter; the two reasoning
      // streams must never share a section boundary either.
      const key = `${agent?.toolUseId ?? ''}:${payload.itemId ?? ''}:${method}`
      const previous = active.sectionIndex.get(key)
      active.sectionIndex.set(key, index)
      const separator = previous !== undefined && index > previous ? '\n\n' : ''
      this.#emitDelta({ type: 'thinking_delta', thinking: separator + payload.delta }, agent?.toolUseId ?? null)
    }
  }

  #itemProgress = (params: unknown): void => {
    const active = this.#activeTurn
    if (!active) {
      return
    }
    const item = (params as { item?: AppServerItem })?.item
    if (item) {
      this.#handleItemProgress(item, active, this.#agentFor(params))
    }
  }

  readonly #notifications: Record<string, (params: unknown) => void> = {
    'thread/started': (params) => {
      const thread = (params as { thread?: { id?: string } })?.thread
      if (typeof thread?.id === 'string') {
        this.#sdkSessionId = thread.id
      }
    },
    'turn/started': (params) => {
      const active = this.#activeTurn
      const turn = (params as { turn?: AppServerTurn })?.turn
      if (active && turn && !active.turnId) {
        active.turnId = turn.id
      }
    },
    'turn/completed': (params) => {
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
      const active = this.#activeTurn
      if (!active) {
        return
      }
      const item = (params as { item?: AppServerItem })?.item
      if (item) {
        this.#handleItemCompleted(item, active, this.#agentFor(params))
      }
    },
    'item/agentMessage/delta': (params) => {
      if (!this.#activeTurn) {
        return
      }
      const delta = (params as { delta?: string })?.delta
      if (typeof delta === 'string' && delta) {
        this.#emitDelta({ type: 'text_delta', text: delta }, this.#agentFor(params)?.toolUseId ?? null)
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
      active.usage.inputTokens += last.inputTokens ?? 0
      active.usage.cachedInputTokens += last.cachedInputTokens ?? 0
      active.usage.cacheWriteInputTokens = (active.usage.cacheWriteInputTokens ?? 0) + (last.cacheWriteInputTokens ?? 0)
      active.usage.outputTokens += last.outputTokens ?? 0
      active.usage.reasoningOutputTokens += last.reasoningOutputTokens ?? 0
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
      const active = this.#activeTurn
      if (!active) {
        return
      }
      const plan = (params as AppServerPlanUpdate)?.plan
      if (!Array.isArray(plan)) {
        return
      }
      this.#emit({
        type: 'sdk_event',
        payload: {
          type: 'codex.todo_list',
          id: `${active.nonce}:plan`,
          items: plan.map((step) => ({ text: step.step, completed: step.status === 'completed' })),
        },
      })
    },
    'serverRequest/resolved': (params) => {
      const requestId = (params as { requestId?: string | number })?.requestId
      if (requestId === undefined) {
        return
      }
      for (const [id, pending] of this.#approvals) {
        if (pending.wireId === requestId) {
          // Reported as a deny because codex's own choice is unknowable; the message says who decided.
          this.#settleApproval(id, pending, { behavior: 'deny', message: 'resolved by codex' }, 'policy')
          return
        }
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
    throw new JsonRpcError(-32601, `workerdeck does not handle server request '${method}'`)
  }

  #requestApproval(channel: ApprovalChannel, method: string, params: unknown, wireId: string | number | undefined): Promise<unknown> {
    if (method === 'item/tool/requestUserInput') {
      const behavior = this.#config.questionBehavior ?? 'ask'
      if (behavior !== 'ask') {
        return Promise.resolve(this.#resolveQuestionByPolicy(channel, params, behavior))
      }
    }
    const id = randomUUID()
    const timeoutMs = this.#config.approvalTimeoutMs ?? this.#config.defaultApprovalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    const itemId = channel.itemId(params)
    const request: PermissionRequest = {
      id,
      ...channel.describe(params),
      toolUseId: itemId ? `${this.#activeTurn?.nonce ?? 'codex'}:${itemId}` : id,
      expiresAt: Date.now() + timeoutMs,
    }
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#approvals.get(id)
        if (pending) {
          this.#settleApproval(id, pending, { behavior: 'deny', message: 'Approval timed out' }, 'timeout')
        }
      }, timeoutMs)
      this.#approvals.set(id, {
        request,
        channel,
        params,
        offered: offeredDecisions(params),
        wireId,
        timer,
        respond: resolve,
      })
      this.#emit({ type: 'permission_requested', request })
      if (this.#activeTurn) {
        this.#setStatus('awaiting_approval')
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
    this.#emit({ type: 'permission_requested', request })
    if (mode === 'deny') {
      this.#emit({
        type: 'permission_resolved',
        requestId: request.id,
        behavior: 'deny',
        resolvedBy: 'policy',
        message: 'Interactive questions are disabled for this session — choose the most reasonable option yourself and continue.',
      })
      return { answers: {} }
    }
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of (params as AppServerUserInputParams).questions ?? []) {
      const first = question.options?.[0]?.label
      if (first) {
        answers[question.id] = { answers: [first] }
      }
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: request.id,
      behavior: 'allow',
      resolvedBy: 'policy',
    })
    return { answers }
  }

  #settleApproval(id: string, pending: PendingCodexApproval, decision: PermissionDecision, resolvedBy: PermissionDecisionSource): void {
    clearTimeout(pending.timer)
    this.#approvals.delete(id)
    let behavior = decision.behavior
    let message = decision.behavior === 'deny' ? (decision.message ?? 'Denied') : undefined
    let sent: { response: unknown; decision?: string }
    if (decision.behavior === 'allow') {
      const allowed = pending.channel.allow(pending.params, decision.updatedInput, pending.offered)
      if (allowed) {
        sent = allowed
      } else {
        behavior = 'deny'
        resolvedBy = 'policy'
        message = 'codex offered no plain accept for this request (only broader session/policy grants) — denied instead'
        sent = pending.channel.deny(pending.params, false, pending.offered)
      }
    } else {
      sent = pending.channel.deny(pending.params, decision.interrupt === true, pending.offered)
    }
    pending.respond(sent.response)
    this.#emit({ type: 'permission_resolved', requestId: id, behavior, resolvedBy, message })
    if (behavior === 'deny' && decision.behavior === 'deny' && decision.interrupt && sent.decision !== 'cancel') {
      void this.#interruptTurn()
    }
    if (!this.#closed && this.#approvals.size === 0 && this.#status === 'awaiting_approval') {
      this.#setStatus('running')
    }
  }

  #handleItemProgress(item: AppServerItem, active: ActiveTurn, agent?: CodexAgent): void {
    const id = `${active.nonce}:${item.id}`
    if (item.type === 'subAgentActivity') {
      this.#itemCompleted.subAgentActivity(item, active, id, agent)
      return
    }
    if (item.type === 'commandExecution' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, 'CodexCommand', { command: item.command }, agent)
      return
    }
    if (item.type === 'mcpToolCall' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, `mcp__${item.server}__${item.tool}`, item.arguments, agent)
      return
    }
    if (item.type === 'collabAgentToolCall' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, CODEX_COLLAB_TOOL, collabInput(item), agent)
      return
    }
    if (item.type === 'imageGeneration' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, CODEX_IMAGE_TOOL, imageGenerationInput(item), agent)
      if (item.savedPath) {
        this.#emitFileProduced(item.savedPath, id)
      }
    }
  }

  #handleItemCompleted(item: AppServerItem, active: ActiveTurn, agent?: CodexAgent): void {
    const id = `${active.nonce}:${item.id}`
    const handler = this.#itemCompleted[item.type] as
      | ((item: AppServerItem, active: ActiveTurn, id: string, agent?: CodexAgent) => void)
      | undefined
    if (handler) {
      handler(item, active, id, agent)
      return
    }
    const unknown = item as AppServerUnknownItem
    this.#emit({ type: 'sdk_event', payload: { type: `codex.${unknown.type}`, item: unknown } })
  }

  readonly #itemCompleted: {
    [K in AppServerItem['type']]: (item: Extract<AppServerItem, { type: K }>, active: ActiveTurn, id: string, agent?: CodexAgent) => void
  } = {
    userMessage: (item, active, _id, agent) => {
      if (!agent) {
        return
      }
      const text = historyUserText(item)
      if (!text) {
        return
      }
      this.#emit({
        type: 'user_message',
        message: { role: 'user', content: text },
        parentToolUseId: agent.toolUseId,
        uuid: `${active.nonce}:${item.id}`,
      })
    },
    agentMessage: (item, active, id, agent) => {
      const text = typeof item.text === 'string' ? item.text : ''
      this.#emitAssistant(id, [{ type: 'text', text }], agent?.toolUseId ?? null)
      if (!agent) {
        active.finalText = text
      }
    },
    reasoning: (item, _active, id, agent) => {
      const summary = Array.isArray(item.summary) ? item.summary.filter(Boolean) : []
      const content = Array.isArray(item.content) ? item.content.filter(Boolean) : []
      const thinking = (summary.length > 0 ? summary : content).join('\n\n')
      if (thinking) {
        this.#emitAssistant(id, [{ type: 'thinking', thinking }], agent?.toolUseId ?? null)
      }
    },
    commandExecution: (item, active, id, agent) => {
      if (!active.toolUseEmitted.has(id)) {
        active.toolUseEmitted.add(id)
        this.#emitToolUse(id, 'CodexCommand', { command: item.command }, agent)
      }
      const exitCode = item.exitCode ?? undefined
      const failed = item.status === 'failed' || item.status === 'declined' || (exitCode !== undefined && exitCode !== 0)
      const output = (item.aggregatedOutput ?? '') + (exitCode !== undefined && exitCode !== 0 ? `\n(exit code ${exitCode})` : '')
      this.#emitToolResult(id, output, failed, undefined, agent?.toolUseId ?? null)
    },
    fileChange: (item, _active, id, agent) => {
      this.#emitToolUse(id, 'CodexFileChange', { changes: item.changes }, agent)
      const lines = item.changes.map((change) => {
        const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type
        return `${kind ?? 'change'}: ${change.path}`
      })
      // A patch names one file, and a multi-file edit has no honest way to say which.
      const only = item.changes.length === 1 ? item.changes[0] : undefined
      this.#emitToolResult(
        id,
        lines.join('\n') || item.status,
        item.status === 'failed' || item.status === 'declined',
        only?.diff ? parseUnifiedDiff(only.diff, only.path) : undefined,
        agent?.toolUseId ?? null,
      )
    },
    mcpToolCall: (item, active, id, agent) => {
      if (!active.toolUseEmitted.has(id)) {
        active.toolUseEmitted.add(id)
        this.#emitToolUse(id, `mcp__${item.server}__${item.tool}`, item.arguments, agent)
      }
      const isError = (item.error !== undefined && item.error !== null) || item.status === 'failed'
      this.#emitToolResult(
        id,
        item.error?.message ?? (item.result === undefined || item.result === null ? '' : JSON.stringify(item.result)),
        isError,
        undefined,
        agent?.toolUseId ?? null,
      )
    },
    webSearch: (item, _active, id, agent) => {
      this.#emitToolUse(id, 'CodexWebSearch', { query: item.query }, agent)
      this.#emitToolResult(id, '', false, undefined, agent?.toolUseId ?? null)
    },
    imageGeneration: (item, active, id, agent) => {
      // Re-emitted without the `toolUseEmitted` guard: `savedPath` only exists now, and the
      // reducer upserts a tool_use by id, so this replaces the in-progress card's input.
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, CODEX_IMAGE_TOOL, imageGenerationInput(item), agent)
      if (item.savedPath) {
        this.#emitFileProduced(item.savedPath, id)
      }
      const lines = [
        item.savedPath ? `Saved to ${item.savedPath}` : 'No saved path reported',
        ...(shortResult(item.result) ? [item.result] : []),
      ]
      this.#emitToolResult(id, lines.join('\n'), item.status === 'failed', undefined, agent?.toolUseId ?? null)
    },
    imageView: (item, _active, id, agent) => {
      this.#emitToolUse(id, 'CodexImageView', { path: item.path }, agent)
      this.#emitToolResult(id, item.path, false, undefined, agent?.toolUseId ?? null)
    },
    // Codex auto-compacts silently. Before this arm the item fell through to `sdk_event`, which no
    // client renders — so the conversation kept going, the model quietly stopped being able to see
    // the top of it, and the transcript said nothing had happened.
    contextCompaction: (_item, _active, id, agent) => {
      this.#emit({ type: 'context_compacted', uuid: id, parentToolUseId: agent?.toolUseId ?? null })
    },
    subAgentActivity: (item, _active, id, agent) => {
      if (this.#replayingHistory) {
        if (item.kind !== 'started') {
          return
        }
        this.#emitToolUse(
          id,
          CODEX_AGENT_TOOL,
          {
            ...(agentName(item.agentPath) ? { subagent_type: agentName(item.agentPath) } : {}),
            agentThreadId: item.agentThreadId,
            ...(item.agentPath ? { agentPath: item.agentPath } : {}),
          },
          agent,
        )
        // A resumed thread's history holds the root's items only, so a replayed agent row closes
        // neutrally: the one claim history cannot back is that the agent failed.
        this.#emitToolResult(
          id,
          "(ran in its own thread — its work is not part of this thread's stored history)",
          false,
          undefined,
          agent?.toolUseId ?? null,
        )
        return
      }
      const record = this.#agents.get(item.agentThreadId) ?? this.#agents.open(item.agentThreadId, id, undefined, Date.now())
      const name = agentName(item.agentPath)
      const relabel = record.agentType === undefined && name !== undefined
      if (relabel) {
        record.agentType = name
      }
      if (!record.anchored || relabel) {
        record.anchored = true
        this.#emitToolUse(
          record.toolUseId,
          CODEX_AGENT_TOOL,
          {
            ...(record.agentType ? { subagent_type: record.agentType } : {}),
            agentThreadId: item.agentThreadId,
            ...(item.agentPath ? { agentPath: item.agentPath } : {}),
          },
          agent,
        )
      }
      if (item.kind === 'interrupted') {
        if (record.status === 'running') {
          this.#agents.settle(record, 'failed')
          this.#emitToolResult(record.toolUseId, 'interrupted', true)
        }
        return
      }
      if (item.kind !== 'started' && record.status !== 'running') {
        this.#agents.revive(record)
      }
    },
    collabAgentToolCall: (item, active, id, agent) => {
      if (!active.toolUseEmitted.has(id)) {
        active.toolUseEmitted.add(id)
        this.#emitToolUse(id, CODEX_COLLAB_TOOL, collabInput(item), agent)
      }
      if (item.status === 'inProgress') {
        return
      }
      const failed = item.status === 'failed' || item.status === 'declined'
      this.#emitToolResult(id, failed ? item.status : '', failed, undefined, agent?.toolUseId ?? null)
    },
  }

  #emitDelta(delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }, parent: string | null): void {
    if (this.#config.includePartialMessages === false) {
      return
    }
    this.#emit({
      type: 'stream_delta',
      event: { type: 'content_block_delta', delta },
      parentToolUseId: parent,
      uuid: randomUUID(),
    })
  }

  #emitAssistant(uuid: string, content: ContentBlock[], parent: string | null): void {
    this.#emit({
      type: 'assistant_message',
      message: { role: 'assistant', content, model: this.#model ?? this.#resolvedModel },
      parentToolUseId: parent,
      uuid,
    })
  }

  #emitToolUse(id: string, name: string, input: unknown, agent?: CodexAgent): void {
    if (agent && !agent.counted.has(id)) {
      agent.counted.add(id)
      agent.toolCount += 1
    }
    this.#emit({
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
        model: this.#model ?? this.#resolvedModel,
      },
      parentToolUseId: agent?.toolUseId ?? null,
      uuid: `${id}-use`,
    })
  }

  #emitToolResult(toolUseId: string, content: string, isError: boolean, patch?: FilePatch, parent: string | null = null): void {
    this.#emit({
      type: 'user_message',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError || undefined }],
      },
      parentToolUseId: parent,
      synthetic: true,
      patch,
      uuid: `${toolUseId}-result`,
    })
  }

  #finishTurn(kind: 'success' | 'failure', startedAt: number, active: ActiveTurn, errors?: string[]): void {
    for (const [id, pending] of this.#approvals) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'Turn ended' }, 'policy')
    }
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
    this.#emitContextUsage(active)
    this.#setStatus('idle')
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
      this.#emit({
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
      this.#emit({ type: 'plan_info', subscriptionType: limits.planType })
    }
  }

  #emitContextUsage(active: ActiveTurn): void {
    const totalTokens = active.contextTokens
    const maxTokens = active.contextWindow
    if (totalTokens === undefined || !maxTokens || maxTokens <= 0) {
      return
    }
    this.#emit({
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
    if (this.#replayingHistory && (body.type === 'assistant_message' || body.type === 'user_message')) {
      body = { ...body, replay: true }
    }
    this.#subscribers.emit(this.#log.append(body))
  }
}
