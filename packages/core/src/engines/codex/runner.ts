import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_CAPABILITIES,
  PROTOCOL_VERSION,
  type ContentBlock,
  type CreateSessionRequest,
  type PermissionDecisionSource,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type McpServerStatusInfo,
  type SessionStatus,
  type SkillInfo,
  type UserQuestion,
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

/**
 * thread/start's sandbox axis (string form) — our permission modes as codex
 * sandbox modes: `default` → read-only (reads run; any mutation is refused by
 * the OS sandbox and — with the ask policy below — escalates to a real
 * question), `acceptEdits` → workspace-write (in-workspace writes sail
 * through, the acceptEdits grant), `bypassPermissions` → danger-full-access.
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
 * The approval axis, stated as the GRANULAR object on both thread/start and
 * turn/start — never the string vocabulary, deliberately and unconditionally:
 * measured against 0.146.0, plain `'untrusted'` never asked anything (a
 * sandbox-violating write was silently refused, a safe echo auto-approved),
 * while the granular flags make a blocked action a real server→client
 * question. Granular policies are gated on `capabilities.experimentalApi` at
 * initialize; WorkerDeck declares it always and keeps NO non-experimental
 * fallback — a future binary that rejects either gate fails loudly (see
 * {@link CodexRunner.#ensureThread}) instead of quietly not asking.
 *
 * `default`/`acceptEdits` ask (all flags on — the sandbox axis above already
 * decides *what needs asking*); `bypassPermissions` asks nothing, same shape.
 */
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
const APPROVAL_POLICY_BY_MODE: Partial<Record<PermissionMode, object>> = {
  default: GRANULAR_ASK,
  acceptEdits: GRANULAR_ASK,
  bypassPermissions: GRANULAR_NEVER,
}

/** Fallback timeout for a pending approval nobody answers — the SessionRunner
 * default, so unattended codex sessions land the same way Claude ones do. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

/**
 * Tool name for codex's built-in `image_gen`. A stable string because it is a
 * rendering contract: both clients key an icon (and, where they can reach the
 * host filesystem, an inline preview) off it.
 */
export const CODEX_IMAGE_TOOL = 'CodexImageGeneration'

/** Longest `result` worth putting in a tool card. The field is free-form and
 * undocumented; anything past this is assumed to be an encoded image rather
 * than a sentence, and encoded images do not go in the event log. */
const MAX_IMAGE_RESULT_CHARS = 512

const shortResult = (result: string): boolean =>
  result.length > 0 && result.length <= MAX_IMAGE_RESULT_CHARS && !result.startsWith('data:')

/**
 * `file_produced.fileId` — derived from the path, not minted fresh.
 *
 * Two properties fall out of that and both are load-bearing: codex reports the
 * same `savedPath` on the progress item and again on the completed one, so a
 * derived id makes the second emission a no-op instead of a duplicate row; and
 * a session rebuilt from a snapshot re-derives the same ids, so a client's
 * cached URL still resolves after a park/restore.
 */
function producedFileId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32)
}

/** Media type from the extension, for the handful a client renders inline.
 * Undefined for everything else — the route sniffs, and guessing here is how a
 * text file ends up labelled `image/png`. */
function producedMediaType(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return PRODUCED_MEDIA_TYPES[extension]
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

/**
 * Codex's `SkillMetadata` as the protocol states it. `interface.shortDescription`
 * beats the legacy top-level one (codex's own comment says to prefer it), and
 * `enabled` defaults to true — an entry codex listed without the field is one it
 * considers live, and defaulting to false would hide working skills.
 */
function skillInfo(skill: AppServerSkillMetadata): SkillInfo {
  return {
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.interface?.shortDescription ?? skill.shortDescription
      ? { shortDescription: skill.interface?.shortDescription ?? skill.shortDescription }
      : {}),
    ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
    ...(skill.interface?.defaultPrompt ? { defaultPrompt: skill.interface.defaultPrompt } : {}),
    ...(skill.scope ? { scope: skill.scope } : {}),
    enabled: skill.enabled !== false,
  }
}

/**
 * Codex's MCP status → the protocol's, which is Claude Code's vocabulary
 * ('connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled').
 *
 * Two inputs, and the auth one wins where it applies: a server that started
 * fine but has no credential is *needs-auth*, not connected, because that is
 * the thing the operator has to act on. `notLoggedIn` is the only auth value
 * that means "unusable" — `unsupported` is the normal answer for a stdio server
 * that has no auth concept at all.
 *
 * A server with no startup notification yet is 'pending', not 'connected':
 * `mcpServerStatus/list` alone only proves it is *configured*.
 */
function mcpStatusOf(
  authStatus: string | undefined,
  update: { status: string; failureReason?: string } | undefined,
  hasTools: boolean,
): string {
  if (update?.status === 'failed') {
    return update.failureReason === 'reauthenticationRequired' ? 'needs-auth' : 'failed'
  }
  // codex's 'cancelled' has no Claude equivalent; it means the startup was
  // abandoned, which for a reader is the same actionable state as failed.
  if (update?.status === 'cancelled') return 'failed'
  if (authStatus === 'notLoggedIn') return 'needs-auth'
  if (update?.status === 'ready') return 'connected'
  // **Tools imply connected, and this branch is not a nicety.** The startup
  // notifications only fire for servers that come up *while we are attached*;
  // a session whose child already had its servers running receives none at all
  // (measured against the real binary — a working server with three tools and
  // no notification). Tools can only have been enumerated over a completed
  // handshake, so their presence is direct evidence the server is up, and
  // without this a healthy server would read as 'pending' forever.
  if (hasTools) return 'connected'
  // No notification and nothing exposed. Genuinely ambiguous: not started yet,
  // or switched off in config — and `mcpServerStatus/list` cannot tell the two
  // apart (it lists disabled servers too, also toolless). 'pending' is the
  // honest one of the two; claiming 'disabled' would be a guess.
  return 'pending'
}

/** One `mcpServerStatus/list` entry as the protocol states it. */
function mcpServerInfo(
  server: AppServerMcpServerStatus,
  update: { status: string; error?: string; failureReason?: string } | undefined,
): McpServerStatusInfo {
  // A map keyed by tool name, not an array — and the key is authoritative when
  // the value omits its own `name`.
  const tools = Object.entries(server.tools ?? {}).flatMap(([key, tool]) => {
    if (!tool) return []
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
                ...(annotations.destructiveHint != null
                  ? { destructive: annotations.destructiveHint }
                  : {}),
                ...(annotations.openWorldHint != null
                  ? { openWorld: annotations.openWorldHint }
                  : {}),
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
    ...(server.serverInfo?.name
      ? { serverInfo: { name: server.serverInfo.name, version: server.serverInfo.version ?? '' } }
      : {}),
    // Deliberately no `transport`/`command`/`args`/`url`: the list response
    // carries none of them. Inventing a transport from the server's name would
    // be a guess rendered as a fact, and the panel already omits what is absent.
    ...(tools.length > 0 ? { tools } : {}),
  }
}

/** What the card shows while the picture is being made, and after. `savedPath`
 * only exists once it lands — a client keys its preview off it, so it is a
 * field rather than a sentence in the result text. */
function imageGenerationInput(item: AppServerImageGenerationItem): Record<string, unknown> {
  return {
    ...(item.revisedPrompt ? { prompt: item.revisedPrompt } : {}),
    ...(item.savedPath ? { savedPath: item.savedPath } : {}),
  }
}

/**
 * The experimental per-request decision list, normalized to names: a string
 * entry is its own name, a structured entry (`{acceptWithExecpolicyAmendment:
 * …}`) is named by its key. Undefined = the request stated no list and the
 * channel's schema enum applies. Present only under `experimentalApi: true` —
 * which WorkerDeck always declares.
 */
function offeredDecisions(params: unknown): Set<string> | undefined {
  const raw = (params as { availableDecisions?: unknown })?.availableDecisions
  if (!Array.isArray(raw)) return undefined
  const names = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string') names.add(entry)
    else if (entry && typeof entry === 'object') {
      for (const key of Object.keys(entry)) names.add(key)
    }
  }
  return names.size > 0 ? names : undefined
}

/**
 * Decision picking for the `{decision: …}` channels (commandExecution,
 * fileChange), honoring the request's own `availableDecisions`:
 *
 * - allow → 'accept' when offered (or when no list was stated). A request
 *   offering only the broader accepts ('acceptForSession',
 *   'acceptWithExecpolicyAmendment') yields undefined: a one-shot allow must
 *   not be silently widened into a session-wide or persistent policy grant, so
 *   the caller answers with the denial and says why.
 * - deny → 'decline', always: the response schema declares it unconditionally,
 *   and it was verified live against 0.146.0 answering a request whose
 *   availableDecisions omitted it — the turn completed cleanly. The list's job
 *   is to gate the accept variants, not to take "no, but keep going" away
 *   (its own alternative, 'cancel', would interrupt the whole turn).
 * - deny+interrupt → 'cancel' (codex's deny-and-interrupt) when offered;
 *   otherwise 'decline', and the caller interrupts the turn itself.
 */
function pickDecision(
  behavior: 'allow' | 'deny',
  interrupt: boolean,
  offered: Set<string> | undefined,
): string | undefined {
  const has = (name: string) => !offered || offered.has(name)
  if (behavior === 'allow') return has('accept') ? 'accept' : undefined
  if (interrupt && has('cancel')) return 'cancel'
  return 'decline'
}

/** Codex `requestUserInput` questions in the AskUserQuestion wire shape both
 * clients already render (QuestionPrompt / QuestionPromptView). */
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

/** The text of a history `userMessage` item: its content entries' text parts
 * joined. Image parts have no replayable representation (the bytes went to the
 * model, not into the rollout we can render from) and are skipped. */
function historyUserText(item: AppServerUserMessageItem): string {
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) => {
      const candidate = part as { type?: string; text?: unknown } | null
      return candidate?.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** The AskUserQuestion answer convention (question text → chosen label(s),
 * comma-joined) mapped back to codex's id-keyed shape. Questions the client
 * did not answer are absent, not empty. */
function codexAnswers(
  questions: readonly AppServerUserInputQuestion[],
  answers: Record<string, unknown> | undefined,
): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {}
  for (const question of questions) {
    const value = answers?.[question.question] ?? answers?.[question.id]
    if (typeof value === 'string' && value.length > 0) out[question.id] = { answers: [value] }
  }
  return out
}

type ApprovalSurface = Pick<
  PermissionRequest,
  'toolName' | 'input' | 'title' | 'displayName' | 'description' | 'decisionReason'
>

/**
 * One server→client ask channel: how it surfaces as a {@link PermissionRequest}
 * and what its wire responses are. `allow` may return undefined — the request
 * offered no plain accept — in which case the caller answers with `deny` and
 * says so. `decision` names the wire decision when the channel has one, so the
 * caller knows whether a deny+interrupt still needs an explicit
 * `turn/interrupt` ('cancel' carries the interrupt itself).
 */
type ApprovalChannel = {
  describe(params: unknown): ApprovalSurface
  itemId(params: unknown): string | undefined
  allow(
    params: unknown,
    updatedInput: Record<string, unknown> | undefined,
    offered: Set<string> | undefined,
  ): { response: unknown; decision?: string } | undefined
  deny(
    params: unknown,
    interrupt: boolean,
    offered: Set<string> | undefined,
  ): { response: unknown; decision?: string }
}

/** The two channels whose response is `{decision: …}` share their pick logic. */
function decisionChannel(
  describe: (params: unknown) => ApprovalSurface,
  itemId: (params: unknown) => string | undefined,
): ApprovalChannel {
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

/**
 * The ask channels, wired to the permission surface. Anything not listed here
 * still gets a JSON-RPC -32601 — never a hang (an unanswered server request
 * wedges the turn).
 */
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
        // Codex's own sentence is the truth of what is being asked: for a
        // sandbox escalation it reads "command failed; retry without sandbox?"
        // — an after-the-refusal question, NOT a pre-execution gate — and the
        // clients render `title` verbatim, so the tense stays honest.
        title:
          params.reason ??
          (command ? `Codex wants to run: ${command}` : 'Codex wants to run a command'),
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
    // Allow grants exactly what was asked (or the client's narrowed rewrite via
    // `updatedInput.permissions`), scoped to the turn — the response's default
    // scope, never 'session'.
    allow: (raw, updatedInput) => ({
      response: {
        permissions:
          (updatedInput?.permissions as Record<string, unknown> | undefined) ??
          (raw as AppServerPermissionsApprovalParams).permissions ??
          {},
      },
    }),
    // This channel's "no" is an empty grant.
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
          ...(params.requestedSchema !== undefined
            ? { requestedSchema: params.requestedSchema }
            : {}),
          ...(params.url ? { url: params.url } : {}),
        },
        title: params.serverName
          ? `MCP server '${params.serverName}' requests input`
          : 'An MCP server requests input',
        displayName: 'MCP elicitation',
        description: params.message ?? undefined,
        decisionReason: undefined,
      }
    },
    itemId: () => undefined,
    // An allow's `updatedInput` IS the elicitation content (the filled form);
    // content is nullable in the schema, so an allow without one is an accept
    // with no content and the MCP server judges it.
    allow: (_raw, updatedInput) => ({
      response: {
        action: 'accept',
        ...(updatedInput !== undefined ? { content: updatedInput } : {}),
      },
    }),
    // 'cancel' here cancels the ELICITATION, not the codex turn — no
    // `decision` is reported, so a deny+interrupt still interrupts the turn
    // explicitly.
    deny: (_raw, interrupt) => ({ response: { action: interrupt ? 'cancel' : 'decline' } }),
  },
}

/** One pending server→client approval: the surfaced request, the channel that
 * knows its wire vocabulary, and the resolver that answers the JSON-RPC
 * request when a decision lands. */
type PendingCodexApproval = {
  request: PermissionRequest
  channel: ApprovalChannel
  params: unknown
  offered: Set<string> | undefined
  /** JSON-RPC wire id — `serverRequest/resolved` names it when codex settles
   * the request itself. */
  wireId: string | number | undefined
  timer: ReturnType<typeof setTimeout>
  respond: (response: unknown) => void
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
  /** Timeout for pending approvals when the request itself doesn't set one.
   * Default 300000 — the SessionRunner default. */
  defaultApprovalTimeoutMs?: number
  /** With `resume`: replay the thread's prior turns as `replay: true` events
   * before anything else, so late-attaching clients get a full transcript —
   * the SessionRunner option, same name, same default (true). */
  backfillHistory?: boolean
}

/** One queued user message: the input for exactly one turn. */
type QueuedTurn = { input: AppServerUserInput[] }

/**
 * Name a subscription window by its measured length, so codex's positional
 * windows land in the protocol's named vocabulary. The two names clients
 * already understand are exact matches for codex's durations (300 min = 5h,
 * 10080 min = 7d); anything else keeps a self-describing key rather than
 * borrowing a name that would size it wrongly.
 */
function rateLimitWindowName(minutes: number | null | undefined): string | undefined {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return undefined
  if (minutes === 300) return 'five_hour'
  if (minutes === 10_080) return 'seven_day'
  return `window_${minutes}m`
}

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
  /** Context occupancy from the most recent model request, with the window it
   * was measured against. NOT `total` — see {@link CodexRunner.emitContextUsage}. */
  contextTokens?: number
  contextWindow?: number
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
  /** Last reported ChatGPT plan, so `plan_info` is emitted once per change. */
  #planType: string | undefined
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
  /** Pending server→client approvals, keyed by the surfaced request id. */
  #approvals = new Map<string, PendingCodexApproval>()
  /** True from start() until the resume backfill (the turn chain's first link)
   * settles — while set, sendMessage defers its user_message echo behind the
   * chain so a new turn can never precede or interleave the replayed history. */
  #backfillPending = false
  /** The resumed thread's prior turns, stashed by {@link #ensureThread} from
   * the ONE thread/resume the backfill consumes (`partial` = the response's
   * turnsBackwardsCursor said older turns exist beyond this page). A mid-life
   * reconnect also goes through thread/resume, but with no backfill pending
   * nothing is stashed — history is never replayed twice. */
  #resumedHistory: { turns: AppServerHistoryTurn[]; partial: boolean } | undefined
  /** Set around history replay: {@link #emit} stamps `replay: true` onto the
   * message events the live item mapping produces. */
  #replayingHistory = false
  /** Last `skills` payload emitted, serialized — the comparison that keeps a
   * `skills/changed` storm (the watcher fires per touched file) from filling
   * the event log with identical lists. */
  #skillsFingerprint: string | undefined
  /** In-flight `skills/list`, so a burst of `skills/changed` makes one call.
   * The pending promise is reused rather than queued: the request has no
   * arguments, so a second one would ask the same question. */
  #skillsRefresh: Promise<void> | undefined
  /** Host paths already announced via `file_produced`, so the same picture
   * reported on both the progress and the completed item registers once. */
  #producedPaths = new Set<string>()
  /** Per-server liveness, accumulated from `mcpServer/startupStatus/updated`.
   * `mcpServerStatus/list` does not carry a status field at all, so without
   * this every server would read as "configured" and never as up or down. */
  #mcpStatus = new Map<string, { status: string; error?: string; failureReason?: string }>()

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
    return [...this.#approvals.values()].map((pending) => pending.request)
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
      pendingPermissionCount: this.#approvals.size,
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

  /** Host-facing rename: writes `meta.title`, which `#title()` prefers. Clearing
   * it (undefined) restores the derived title. The engine is never told. */
  setTitle(title: string | undefined): void {
    const meta = { ...this.#config.meta }
    if (title) meta.title = title
    else delete meta.title
    this.#config = { ...this.#config, meta }
  }

  start(): Promise<void> {
    if (this.#started) return this.#turnChain
    this.#started = true
    if (this.#config.resume && this.#config.backfillHistory !== false) {
      // First link of the turn chain: connect, thread/resume, and replay the
      // thread's prior turns as `replay: true` events before any queued turn
      // runs (and before its echo — see sendMessage). This is also why a
      // promptless resume now connects eagerly rather than on first message:
      // its history is the whole point of attaching to it.
      this.#backfillPending = true
      this.#turnChain = this.#turnChain.then(() => this.#backfillHistory())
    } else {
      this.#setStatus('idle')
    }
    if (this.#config.prompt) this.sendMessage(this.#config.prompt)
    // A session that is about to connect anyway (a prompt to run, or a resume
    // to backfill) gets its skills from that connection a moment later. Only
    // the promptless, non-resume case — the dashboard's "create, then type" —
    // would otherwise sit with no child and therefore no skill list at all,
    // which is the one place codex's own TUI has them and we did not.
    if (!this.#config.prompt && !this.#config.resume) void this.#probeSkills()
    return this.#turnChain
  }

  /**
   * List skills over a **throwaway** connection, for a session with nothing else
   * to do yet.
   *
   * `skills/list` needs a live child but not a thread, so this spawns one, asks,
   * and closes it — rather than bringing up the session's own child early and
   * leaving a codex process parked behind every session someone created and
   * never typed into. The session's real connection re-lists when it arrives;
   * the fingerprint compare in {@link #refreshSkills} makes that a no-op.
   *
   * Entirely best-effort and never awaited: a missing binary, a failed spawn or
   * a rejected handshake here must not turn a session that has not started into
   * a session that failed.
   */
  async #probeSkills(): Promise<void> {
    let connection: AppServerConnection | undefined
    try {
      connection = await this.#openScratchConnection()
      if (this.#closed) return
      await this.#refreshSkills(connection)
    } catch {
      // The session is fine; it simply has no skill list until its own child
      // comes up and asks again.
    } finally {
      connection?.close()
    }
  }

  /**
   * A handshaken child that is **not** the session's — for the questions a
   * client can ask before the session has anything to run (its skills, its MCP
   * servers). The caller owns it and must close it.
   *
   * No onNotification/onRequest/onClose wiring on purpose: this child answers
   * one question and goes away, so its notifications are noise and its death is
   * not the session's problem. The alternative — bringing the session's real
   * child up early — would park a codex process behind every session someone
   * created and never typed into.
   */
  async #openScratchConnection(): Promise<AppServerConnection> {
    const connection = this.#config.connectFn({ env: this.#childEnv() })
    try {
      await connection.request('initialize', {
        clientInfo: {
          name: 'workerdeck',
          title: 'WorkerDeck',
          version: `protocol-${PROTOCOL_VERSION}`,
        },
        capabilities: { experimentalApi: true },
      })
      connection.notify('initialized')
      return connection
    } catch (error) {
      connection.close()
      throw error
    }
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#closed) throw new Error('session is closed')
    const input = this.#buildInput(text, attachments ?? [])
    const echo = () =>
      this.#emit({
        type: 'user_message',
        message: { role: 'user', content: text },
        parentToolUseId: null,
        attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
        uuid: randomUUID(),
      })
    // While a resume's history replay is still pending, the echo rides the
    // turn chain (which the replay heads), so the new turn's user message can
    // never precede the history it follows. Otherwise it is immediate — a
    // message queued behind a running turn still echoes right away.
    if (this.#backfillPending) this.#turnChain = this.#turnChain.then(echo)
    else echo()
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

  /** Resolve a pending approval. Returns false if the id is unknown (e.g.
   * timed out, or already settled by codex itself). */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#approvals.get(requestId)
    if (!pending) return false
    this.#settleApproval(requestId, pending, decision, 'client')
    return true
  }

  async interrupt(): Promise<void> {
    // A pending approval is what's holding the turn open — settle each as a
    // denied interrupt first (codex's 'cancel' where the request offers it,
    // which itself ends the turn).
    for (const [id, pending] of this.#approvals) {
      this.#settleApproval(
        id,
        pending,
        { behavior: 'deny', message: 'interrupted', interrupt: true },
        'policy',
      )
    }
    await this.#interruptTurn()
    await this.#turnChain
  }

  /** Address the in-flight turn only (no approval sweep) — also the follow-up
   * for a deny+interrupt whose wire decision couldn't carry the interrupt. */
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
    // Settle pending approvals before the connection goes: each gets its
    // channel's own "no" on the wire and a permission_resolved in the log.
    for (const [id, pending] of this.#approvals) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'Session closed' }, 'policy')
    }
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
      connection.onRequest((method, params, id) => this.#answerServerRequest(method, params, id))
      connection.onClose((message) => {
        if (this.#connection === connection) {
          this.#connection = undefined
          this.#threadLoaded = false
        }
        // Approvals pending against a dead child can never be answered on the
        // wire — retire their cards and timers.
        for (const [id, pending] of this.#approvals) {
          this.#settleApproval(id, pending, { behavior: 'deny', message }, 'policy')
        }
        // A child dying mid-turn fails that turn (with the exit diagnostic);
        // idle, there is nothing to settle and the next turn respawns.
        this.#activeTurn?.reject(new Error(message))
      })
      try {
        // `experimentalApi` is load-bearing, not a nicety: granular approval
        // policies are rejected without it, and WorkerDeck ships ONE code path
        // (no string-policy fallback). A binary that rejects the capability
        // must fail loudly here — a session that quietly stops asking for
        // approvals is worse than one that refuses to start and says why.
        await connection.request('initialize', {
          clientInfo: {
            name: 'workerdeck',
            title: 'WorkerDeck',
            version: `protocol-${PROTOCOL_VERSION}`,
          },
          capabilities: { experimentalApi: true },
        })
      } catch (error) {
        // Don't leave a half-initialized child around — the next message must
        // respawn from scratch, not talk to a child that refused the handshake.
        connection.close()
        if (this.#connection === connection) this.#connection = undefined
        if (error instanceof JsonRpcError) {
          throw new Error(
            'codex app-server rejected initialize (capabilities.experimentalApi: true — required ' +
              'for the granular approval policy, and WorkerDeck has no non-experimental fallback): ' +
              error.message,
          )
        }
        throw error
      }
      connection.notify('initialized')
    }
    if (!this.#threadLoaded) {
      const options: Record<string, unknown> = {
        cwd: this.#config.cwd,
        approvalPolicy: APPROVAL_POLICY_BY_MODE[this.#permissionMode],
        sandbox: THREAD_SANDBOX_BY_MODE[this.#permissionMode],
      }
      if (this.#model) options.model = this.#model
      const resuming = this.#sdkSessionId !== undefined
      const result = (resuming
        ? await connection.request('thread/resume', { threadId: this.#sdkSessionId, ...options })
        : await connection.request('thread/start', options)) as {
        thread?: { id?: string; turns?: AppServerHistoryTurn[] }
        model?: string | null
        reasoningEffort?: string | null
        /** Non-null: `thread.turns` is one PAGE and older turns exist beyond it. */
        turnsBackwardsCursor?: string | null
      }
      if (typeof result?.thread?.id === 'string') this.#sdkSessionId = result.thread.id
      if (typeof result?.model === 'string') this.#resolvedModel = result.model
      if (typeof result?.reasoningEffort === 'string') this.#resolvedEffort = result.reasoningEffort
      // The resume that backfill is waiting on carries the thread's prior
      // turns — stash them for it. A reconnect after a dead child resumes the
      // same thread but has no backfill pending, so nothing is stashed and
      // history is never replayed twice.
      if (resuming && this.#backfillPending && !this.#resumedHistory) {
        this.#resumedHistory = {
          turns: Array.isArray(result?.thread?.turns) ? result.thread.turns : [],
          partial: typeof result?.turnsBackwardsCursor === 'string',
        }
      }
      this.#threadLoaded = true
    }
    // Fire and forget, and only now: `skills/list` needs a live child, and a
    // codex session does not spawn one until it has something to do. So the
    // skill list arrives with the first turn rather than at create time —
    // which is why clients gate the affordance on having received a `skills`
    // event, not on the capability flag alone.
    void this.#refreshSkills(connection)
    return connection
  }

  /**
   * Re-read `skills/list` and publish it, if it changed.
   *
   * **`cwds` is passed explicitly, and must be.** The schema documents the empty
   * case as "the current session working directory", which reads like the
   * thread's — it is not. Measured against 0.146.0: with no `cwds`, and *after*
   * a `thread/start` carrying this session's cwd, the response comes back keyed
   * to the app-server child's own process directory (for WorkerDeck, wherever
   * the gateway was launched) and reports no repo-scoped skills at all. So a
   * project's own `.codex/skills/**` were invisible until this argument existed.
   *
   * Best-effort throughout. A binary too old to know the method, a broken
   * manifest, a child that died mid-call — none of that is worth failing a
   * session over, and the panel simply stays absent.
   */
  async #refreshSkills(connection: AppServerConnection): Promise<void> {
    if (this.#skillsRefresh) return this.#skillsRefresh
    const run = (async () => {
      try {
        const result = (await connection.request('skills/list', {
          cwds: [this.#config.cwd],
        })) as AppServerSkillsListResponse
        if (this.#closed) return
        const entries = Array.isArray(result?.data) ? result.data : []
        const seen = new Set<string>()
        const skills: SkillInfo[] = []
        for (const entry of entries) {
          for (const skill of entry?.skills ?? []) {
            // The same skill can be reported under several cwds; the first
            // wins, matching how codex itself resolves a name collision.
            if (typeof skill?.name !== 'string' || seen.has(skill.name)) continue
            seen.add(skill.name)
            skills.push(skillInfo(skill))
          }
        }
        skills.sort((a, b) => a.name.localeCompare(b.name))
        const fingerprint = JSON.stringify(skills)
        if (fingerprint === this.#skillsFingerprint) return
        this.#skillsFingerprint = fingerprint
        this.#emit({ type: 'skills', skills })
      } catch {
        // Nothing to say: an engine that cannot list its skills is an engine
        // whose skills panel does not appear.
      } finally {
        this.#skillsRefresh = undefined
      }
    })()
    this.#skillsRefresh = run
    return run
  }

  /**
   * The session's MCP servers, live from the binary.
   *
   * Two sources merged, because codex splits them: `mcpServerStatus/list` says
   * what is configured and what each server exposes (including every tool's
   * full JSON Schema, which the Agent SDK does not give us), and the
   * `mcpServer/startupStatus/updated` notifications say which of them are
   * actually up.
   *
   * Answers **before the session has connected**, over a throwaway child, for
   * the same reason the skill list does: a codex session spawns nothing until
   * it has work, and a panel that said "no MCP servers configured" until the
   * first turn would be stating something false about the operator's config.
   * The request blocks until the servers are enumerated (measured: complete on
   * the very first call), so there is no half-populated answer to race.
   *
   * Resolves undefined only when there is genuinely nothing to say — the
   * session is closed, or the child could not be spoken to. The route turns
   * that into a 501.
   *
   * **Listing only.** There is no per-server reconnect or toggle on this
   * transport — hence no `reconnectMcpServer`/`setMcpServerEnabled` here, and
   * `ENGINE_CAPABILITIES.codex.mcpServerActions: false` so clients render the
   * panel read-only instead of offering buttons that cannot work.
   */
  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    if (this.#closed) return undefined
    const live = this.#connection
    let scratch: AppServerConnection | undefined
    try {
      // The session's own child when it has one — its accumulated
      // `#mcpStatus` makes the answer sharper — and a throwaway otherwise.
      const connection = live ?? (scratch = await this.#openScratchConnection())
      const result = (await connection.request(
        'mcpServerStatus/list',
        {},
      )) as AppServerMcpServerStatusResponse
      return (result?.data ?? []).map((server) =>
        mcpServerInfo(server, this.#mcpStatus.get(server.name)),
      )
    } catch {
      return undefined
    } finally {
      scratch?.close()
    }
  }

  /**
   * Announce a file the ENGINE wrote on the host, so a client can fetch it
   * without the operator having declared its directory as a host-file root.
   *
   * Deliberately narrow: only paths codex reports as *written by its own tool*
   * belong here. A path the model merely read (`imageView`) is an agent-chosen
   * claim, and those keep going through `/fs/*` and its root allowlist — see
   * the note on `file_produced` in the protocol.
   */
  #emitFileProduced(path: string, toolUseId: string): void {
    if (this.#producedPaths.has(path)) return
    this.#producedPaths.add(path)
    let bytes: number | undefined
    try {
      const stat = statSync(path)
      if (stat.isFile()) bytes = stat.size
      // A `savedPath` that is not a regular file is still announced: the route
      // re-checks before serving, and a client showing the path it was given
      // beats one silently dropping it.
    } catch {
      // Reported but not there (yet, or at all) — announce it anyway and let
      // the fetch be the thing that fails.
    }
    this.#emit({
      type: 'file_produced',
      fileId: producedFileId(path),
      path,
      ...(producedMediaType(path) ? { mediaType: producedMediaType(path) } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      toolUseId,
    })
  }

  /**
   * On resume, replay the thread's prior turns as `replay: true` events,
   * seq'd before any live turn — the SessionRunner backfill contract, fed
   * from `thread/resume`'s own `thread.turns`. When the resume response says
   * that page is partial (`turnsBackwardsCursor`), the FULL rollout history
   * is fetched via `thread/read {includeTurns: true}` instead — and if even
   * that fails, the partial page is replayed under a visible notice rather
   * than silently posing as the whole thread. Best-effort like the Claude
   * backfill: an unreadable history never blocks the resume itself.
   */
  async #backfillHistory(): Promise<void> {
    try {
      if (this.#closed) return
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
          if (Array.isArray(full) && full.length >= turns.length) turns = full
          else partialReason = 'thread/read returned less history than the resume page'
        } catch (error) {
          partialReason = error instanceof Error ? error.message : String(error)
        }
      }
      if (partialReason) {
        // Rendered as an inline notice by both clients (the session keeps
        // running) — a truthful-but-partial transcript must say so, above the
        // part it does show.
        this.#emit({
          type: 'session_error',
          message: `Resumed thread history is incomplete — older turns could not be loaded (${partialReason})`,
        })
      }
      this.#replayTurns(turns)
    } catch {
      // A missing/unreadable thread must not block the resume: the next real
      // turn retries the connection and surfaces its own failure loudly.
    } finally {
      this.#backfillPending = false
      this.#setStatus('idle')
    }
  }

  /** Replay historical turns through the SAME item mapping the live path uses. */
  #replayTurns(turns: readonly AppServerHistoryTurn[]): void {
    for (const turn of turns) {
      if (this.#closed) return
      // "Per turn" means per HISTORICAL turn: each replayed turn gets its own
      // nonce exactly as each live turn does — codex item ids restart per turn
      // ("item-1", …), so one shared namespace would fold turn N's items into
      // turn 1's bubbles (b026e70), and a fresh random nonce per turn also
      // keeps replayed ids disjoint from every future live turn's.
      const state = this.#newTurnState()
      this.#replayingHistory = true
      try {
        for (const item of turn.items ?? []) {
          if (item.type === 'userMessage') {
            // Dropped on the live path (sendMessage already echoed it); in
            // history this IS the turn's user message.
            const text = historyUserText(item)
            if (!text) continue
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

  /** Fresh per-turn state — one per live turn, and one per REPLAYED turn (the
   * nonce is the item-id namespace, and its per-turn-ness is the invariant). */
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
    if (this.#closed) return
    const turn = this.#queue.shift()
    if (!turn) return
    this.#setStatus('running')
    const startedAt = Date.now()
    const active: ActiveTurn = this.#newTurnState()
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
        approvalPolicy: APPROVAL_POLICY_BY_MODE[this.#permissionMode],
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
        // Context occupancy is the OPPOSITE choice from the accounting above:
        // `last` (overwritten, not summed) against the window, because a request's
        // input already contains the whole conversation. `total` is cumulative
        // billing — it grows every turn while the context stays where it is, so a
        // meter built on it would climb to 100% on an almost-empty thread
        // (measured: total 13931 → 27878 across two trivial turns, last 13931 →
        // 13947, window 258400).
        const update = params as AppServerTokenUsageUpdate
        active.contextTokens = last.totalTokens ?? undefined
        active.contextWindow = update.tokenUsage?.modelContextWindow ?? undefined
        return
      }
      case 'mcpServer/startupStatus/updated': {
        // The ONLY place a server's liveness comes from — `mcpServerStatus/list`
        // reports what is configured and what it exposes, never whether it is
        // up. Not gated on `active`: servers start with the child, well before
        // any turn.
        const update = params as AppServerMcpStatusUpdate
        if (typeof update?.name !== 'string') return
        this.#mcpStatus.set(update.name, {
          status: typeof update.status === 'string' ? update.status : 'starting',
          ...(update.error ? { error: update.error } : {}),
          ...(update.failureReason ? { failureReason: update.failureReason } : {}),
        })
        return
      }
      case 'skills/changed': {
        // An invalidation signal with no payload — codex's watcher saying
        // "re-run skills/list", which is exactly what this does. Not gated on
        // `active`: the operator can edit a skill between turns, and that is
        // in fact when they usually do.
        const connection = this.#connection
        if (connection) void this.#refreshSkills(connection)
        return
      }
      case 'account/rateLimits/updated': {
        // Pushed during a turn, so — unlike the Claude engine, whose CLI only
        // pushes on change and therefore needs an explicit poll — listening is
        // enough. Not gated on `active`: a window update is about the account,
        // not the turn.
        this.#emitRateLimits((params as { rateLimits?: AppServerRateLimits })?.rateLimits)
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
      case 'serverRequest/resolved': {
        // Codex settled one of its own asks (auto-resolution, e.g.
        // requestUserInput's autoResolutionMs) — retire the matching card. The
        // late JSON-RPC response we still send is ignored by the peer. The
        // resolved event reports 'deny' because we cannot know what codex
        // chose; the message says who really decided.
        const requestId = (params as { requestId?: string | number })?.requestId
        if (requestId === undefined) return
        for (const [id, pending] of this.#approvals) {
          if (pending.wireId === requestId) {
            this.#settleApproval(id, pending, { behavior: 'deny', message: 'resolved by codex' }, 'policy')
            return
          }
        }
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

  /** Answer a server→client request: the ask channels become pending
   * permission requests; anything else gets a JSON-RPC -32601 rather than a
   * hang (an unanswered server request wedges the turn). */
  async #answerServerRequest(
    method: string,
    params: unknown,
    wireId?: string | number,
  ): Promise<unknown> {
    const channel = APPROVAL_CHANNELS[method]
    if (channel) return this.#requestApproval(channel, method, params, wireId)
    throw new JsonRpcError(-32601, `workerdeck does not handle server request '${method}'`)
  }

  /**
   * Surface one ask-channel request as a pending {@link PermissionRequest};
   * the returned promise is the JSON-RPC response, resolved when a
   * `permission_decision` lands — or by the timeout, an interrupt, turn end,
   * session close, or codex resolving it itself. Never left hanging.
   */
  #requestApproval(
    channel: ApprovalChannel,
    method: string,
    params: unknown,
    wireId: string | number | undefined,
  ): Promise<unknown> {
    // AskUserQuestion policy resolution, the SessionRunner convention: 'auto'
    // picks each question's first (recommended) option, 'deny' sends the model
    // back to decide for itself — both visibly, neither pending.
    if (method === 'item/tool/requestUserInput') {
      const behavior = this.#config.questionBehavior ?? 'ask'
      if (behavior !== 'ask') {
        return Promise.resolve(this.#resolveQuestionByPolicy(channel, params, behavior))
      }
    }
    const id = randomUUID()
    const timeoutMs =
      this.#config.approvalTimeoutMs ??
      this.#config.defaultApprovalTimeoutMs ??
      DEFAULT_APPROVAL_TIMEOUT_MS
    const itemId = channel.itemId(params)
    const request: PermissionRequest = {
      id,
      ...channel.describe(params),
      // Anchored to the tool card the turn already emitted for this item (the
      // command that ran and was refused, the file change in flight); channels
      // with no item anchor on the request itself.
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
      if (this.#activeTurn) this.#setStatus('awaiting_approval')
    })
  }

  /** 'auto'/'deny' sessions settle codex questions synchronously instead of
   * pending. Request/resolved events still fire so transcripts and job
   * webhooks show what was chosen. */
  #resolveQuestionByPolicy(
    channel: ApprovalChannel,
    params: unknown,
    mode: 'auto' | 'deny',
  ): unknown {
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
        message:
          'Interactive questions are disabled for this session — choose the most reasonable option yourself and continue.',
      })
      return { answers: {} }
    }
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of (params as AppServerUserInputParams).questions ?? []) {
      const first = question.options?.[0]?.label
      if (first) answers[question.id] = { answers: [first] }
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: request.id,
      behavior: 'allow',
      resolvedBy: 'policy',
    })
    return { answers }
  }

  /**
   * Settle one pending approval: pick the channel's wire response for the
   * decision, answer the JSON-RPC request, and emit `permission_resolved`.
   * An allow the request offered no plain accept for becomes the channel's
   * denial, said out loud — never a silently widened grant, and never a
   * decision the request didn't offer.
   */
  #settleApproval(
    id: string,
    pending: PendingCodexApproval,
    decision: PermissionDecision,
    resolvedBy: PermissionDecisionSource,
  ): void {
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
        message =
          'codex offered no plain accept for this request (only broader session/policy grants) — denied instead'
        sent = pending.channel.deny(pending.params, false, pending.offered)
      }
    } else {
      sent = pending.channel.deny(pending.params, decision.interrupt === true, pending.offered)
    }
    pending.respond(sent.response)
    this.#emit({ type: 'permission_resolved', requestId: id, behavior, resolvedBy, message })
    if (behavior === 'deny' && decision.behavior === 'deny' && decision.interrupt && sent.decision !== 'cancel') {
      // The wire decision couldn't carry the interrupt itself.
      void this.#interruptTurn()
    }
    if (!this.#closed && this.#approvals.size === 0 && this.#status === 'awaiting_approval') {
      this.#setStatus('running')
    }
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
      return
    }
    // Generating a picture takes seconds — the card exists while it runs, like
    // a command's does, rather than appearing only once it is finished.
    if (item.type === 'imageGeneration' && !active.toolUseEmitted.has(id)) {
      active.toolUseEmitted.add(id)
      this.#emitToolUse(id, CODEX_IMAGE_TOOL, imageGenerationInput(item))
      // Rare but real: a progress item can already carry `savedPath`. Announce
      // it here too — `#emitFileProduced` dedupes by path, so the completed
      // item's second report costs nothing.
      if (item.savedPath) this.#emitFileProduced(item.savedPath, id)
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
        // The completed item: by the time it lands the patch applied, failed,
        // or was declined (a pending proposal rides the approval channel, not
        // this item). v2's `kind` is an object (`{type: 'update', …}`), mapped
        // defensively.
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
      case 'imageGeneration': {
        // Re-emitted, not guarded by `toolUseEmitted`: `savedPath` only exists
        // now, and the reducer upserts a tool_use by id — so this replaces the
        // in-progress card's input with the finished one. The result event
        // follows immediately, which is what settles the status again.
        active.toolUseEmitted.add(id)
        this.#emitToolUse(id, CODEX_IMAGE_TOOL, imageGenerationInput(item))
        // The path IS the deliverable — the bytes live on the host and no event
        // may carry them. `file_produced` is what makes those bytes reachable
        // anyway: the gateway serves a path its own runner reported, with no
        // host-file root to declare first.
        if (item.savedPath) this.#emitFileProduced(item.savedPath, id)
        const lines = [
          item.savedPath ? `Saved to ${item.savedPath}` : 'No saved path reported',
          ...(shortResult(item.result) ? [item.result] : []),
        ]
        this.#emitToolResult(id, lines.join('\n'), item.status === 'failed')
        return
      }
      case 'imageView':
        this.#emitToolUse(id, 'CodexImageView', { path: item.path })
        this.#emitToolResult(id, item.path, false)
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
    // Approvals that outlived the turn (codex moved on, or the turn failed
    // around them) are settled now — a card must never outlive what it gates,
    // and an unanswered timer must never fire into a finished turn.
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

  /**
   * Subscription windows, mapped onto the protocol's named vocabulary.
   *
   * The shapes disagree: codex reports windows *positionally* (`primary` /
   * `secondary`) with a length in minutes, while `RateLimitInfo.rateLimitType`
   * is a name whose meaning clients already know — iOS labels `seven_day` as
   * "Weekly" and derives the pace marker's denominator from it. Naming the
   * window by its measured duration is therefore the honest mapping rather
   * than a borrowed one: codex's primary window is 10080 minutes, which *is*
   * seven days. A duration we have no name for keeps an explicit
   * `window_<n>m` key — clients render it verbatim and simply draw no pace
   * marker, which beats mislabeling it as a week.
   *
   * `status` is 'allowed' by construction (the session is running), matching
   * `rateLimitEventsFromUsage`; codex's `rateLimitReachedType` is the one
   * signal that a limit is actually biting, so it becomes 'rejected'.
   */
  #emitRateLimits(limits: AppServerRateLimits | undefined | null): void {
    if (!limits) return
    const status = limits.rateLimitReachedType ? 'rejected' : 'allowed'
    for (const window of [limits.primary, limits.secondary]) {
      // A window with no percentage is unknown, not zero — dropped rather than
      // reported at 0%, the same rule the Claude mapping follows.
      if (!window || window.usedPercent === null || window.usedPercent === undefined) continue
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
    // Emitted once per change, like the Claude engine's — it names the windows
    // rather than sizing them.
    if (limits.planType && limits.planType !== this.#planType) {
      this.#planType = limits.planType
      this.#emit({ type: 'plan_info', subscriptionType: limits.planType })
    }
  }

  /**
   * Context occupancy, after the turn — the same cadence the Claude runner
   * polls `getContextUsage()` on, so clients need nothing new.
   *
   * Emitted only when the binary gave BOTH numbers: the protocol is explicit
   * that a client renders nothing rather than a 0% ring, and a window of
   * `null` (which app-server does send) would otherwise divide into a
   * meaningless percentage. `categories` is empty because codex publishes no
   * breakdown — clients must not render an empty "Breakdown" section for it.
   */
  #emitContextUsage(active: ActiveTurn): void {
    const totalTokens = active.contextTokens
    const maxTokens = active.contextWindow
    if (totalTokens === undefined || !maxTokens || maxTokens <= 0) return
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
    if (this.#status === status) return
    if (this.#status === 'closed' || this.#status === 'failed') return
    this.#status = status
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    // History replay reuses the live item mapping wholesale; the replay flag
    // is stamped here so the mapping itself stays one code path.
    if (this.#replayingHistory && (body.type === 'assistant_message' || body.type === 'user_message')) {
      body = { ...body, replay: true }
    }
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
