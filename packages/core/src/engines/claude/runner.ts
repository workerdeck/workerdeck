import { randomUUID } from 'node:crypto'
import {
  getSessionInfo,
  getSessionMessages,
  query as sdkQuery,
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
  contextReading,
  type ContextReading,
  transcriptActivity,
  type CreateSessionRequest,
  type McpServerStatusInfo,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
} from '@workerdeck/protocol'
import { type AttachmentInput, attachmentContentBlocks, attachmentRef } from '../../lib/attachments.ts'
import { InputQueue } from '../../lib/input-queue.ts'
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
import type { PermissionDecision, Runner, SessionEventListener } from '../../runner-interface.ts'
import { SubscriberSet, type SubscribeOptions } from '../../lib/subscribers.ts'
import { SubagentTracker } from './subagents.ts'

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query

export type HistoryFn = (sdkSessionId: string, options: { dir?: string }) => Promise<SessionMessage[]>

export type SessionInfoFn = (sdkSessionId: string, options: { dir?: string }) => Promise<SDKSessionInfo | undefined>

export type SessionRunnerConfig = CreateSessionRequest & {
  /** Injectable query implementation (tests, instrumentation). Defaults to the SDK's query(). */
  queryFn?: QueryFn
  /** Environment for the spawned Claude Code process. Defaults to process.env. */
  env?: Record<string, string | undefined>
  pathToClaudeCodeExecutable?: string
  /** Escape hatch merged last into the SDK Options. */
  extraOptions?: Partial<Options>
  /** Timeout for pending approvals when the request itself doesn't set one. Default 300000. */
  defaultApprovalTimeoutMs?: number
  /** With `resume`: emit the resumed session's history as replay events before the query
   * starts, so late-attaching clients get a full transcript. Default true. */
  backfillHistory?: boolean
  /** Injectable history reader (tests). Defaults to the SDK's getSessionMessages. */
  historyFn?: HistoryFn
  /** Injectable session-metadata reader (tests). Defaults to the SDK's
   * getSessionInfo — the only place the CLI's own session title is readable
   * from, since no message on the stream carries it. */
  sessionInfoFn?: SessionInfoFn
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

type PendingApproval = {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One live Agent SDK session: owns the query() call, the streaming input queue, the
 * pending-approval table, and a seq-numbered event log that subscribers can replay.
 * No transport — the server (or any host) subscribes and bridges to the wire.
 */
export class SessionRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: SessionRunnerConfig
  /** {@link SessionRunnerConfig.cwd}, checked once in the constructor. */
  readonly #cwd: string
  #events: SessionEvent[] = []
  #subscribers = new SubscriberSet()
  #seq = 0
  /**
   * Latest context-window reading, retained from the last `context_usage` this
   * runner emitted so `GET /sessions` can answer it without an attach — see
   * `SessionInfo.contextUsage`. Folded in the emit path, so it is by
   * construction the same number the transcript last drew.
   */
  #contextUsage: ContextReading | undefined
  #activityCount = 0
  /**
   * Seq of the latest `conversation_reset` event, 0 when none. The log itself is
   * never truncated — it still carries the state-bearing events (`capabilities`,
   * `system_init`, …) a fresh attacher depends on and which are not re-emitted —
   * but `subscribe()` skips transcript *content* strictly below this mark, so a
   * replay does not resurrect a cleared conversation. A later reset supersedes
   * an earlier one by overwriting it.
   */
  #resetSeq = 0
  #status: SessionStatus = 'starting'
  #statusDetail: string | undefined
  #sdkSessionId: string | undefined
  #model: string | undefined
  #apiKeySource: string | undefined
  #permissionMode: PermissionMode | undefined
  #pending = new Map<string, PendingApproval>()
  /**
   * The turn ended while an approval was standing, and nothing has started a
   * new one since.
   *
   * `awaiting_approval` rightly outranks `idle` for display, so a turn-over
   * signal arriving under a standing approval cannot be applied when it lands.
   * It used to be **discarded** for that reason, which is a different thing
   * from outranked: the settle path then asserted `running` on the assumption
   * that an answered approval means work resumes, and when the turn was already
   * over — an interrupt, a timeout — the session claimed to be running one that
   * had produced its result. Status is purely edge-driven here, with no poll and
   * no reconciliation anywhere, so that single dropped edge never came back and
   * every client rendered it faithfully for the life of the session.
   *
   * So the fact is *deferred* rather than dropped, and it is deliberately
   * cleared the moment work genuinely resumes — a turn-over belongs to the turn
   * that produced it and must not settle the next one.
   */
  #turnOverWhileBlocked = false
  /** The read-time sub-agent rollup (`SessionInfo.subagents`), fed from #emit —
   * the one chokepoint — so the resume backfill reconstructs it for free. */
  #subagents = new SubagentTracker()
  #totalCostUsd: number | undefined
  #numTurns: number | undefined
  #lastActivityAt: number | undefined
  #input = new InputQueue()
  #query: Query | undefined
  #capabilitiesEmitted = false
  /** Last plan reported by the usage poll, so `plan_info` is emitted on change
   * rather than once per turn. */
  #subscriptionType: string | undefined
  /** The title the CLI gave this thread (see `#fetchEngineTitle`). Undefined
   * until it has one — a session gets its summary a turn or two in. */
  #engineTitle: string | undefined
  #started = false
  #closed = false
  #runPromise: Promise<void> | undefined

  constructor(config: SessionRunnerConfig, id: string = randomUUID()) {
    // Optional on the wire (an engine with no host filesystem takes none) but
    // required here: this one spawns the CLI in a real directory. The gateway
    // enforces it off `EngineCapabilities.hostCwd`, so reaching this throw means
    // a host built a runner around that check.
    if (!config.cwd) {
      throw new Error('the claude engine requires a cwd')
    }
    this.#cwd = config.cwd
    this.#config = config
    this.#permissionMode = config.permissionMode
    this.id = id
    this.createdAt = Date.now()
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

  /** 'oauth' = claude.ai subscription credentials; other values are API-key provenance. */
  get apiKeySource(): string | undefined {
    return this.#apiKeySource
  }

  get pendingApprovals(): PermissionRequest[] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.#cwd,
      profile: this.#config.profile,
      engine: 'claude',
      capabilities: ENGINE_CAPABILITIES.claude,
      model: this.#model ?? this.#config.model,
      permissionMode: this.#permissionMode,
      // Fixed at spawn: the CLI refuses to switch into bypass unless it was
      // launched for it (see #buildOptions). Reported so a client can disable
      // the mode rather than offer a switch that will be refused.
      canBypassPermissions: this.#config.permissionMode === 'bypassPermissions' || this.#config.allowDangerouslySkipPermissions === true,
      apiKeySource: this.#apiKeySource,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      activityCount: this.#activityCount,
      contextUsage: this.#contextUsage,
      pendingPermissionCount: this.#pending.size,
      subagents: this.#subagents.list(),
      meta: this.#config.meta,
      scope: this.#config.scope,
      title: this.#title(),
      totalCostUsd: this.#totalCostUsd,
      numTurns: this.#numTurns,
      lastActivityAt: this.#lastActivityAt,
    }
  }

  /**
   * Three sources, most-deliberate first: the host's own rename (`meta.title`),
   * the title the CLI gave this thread (`#engineTitle`), then the first prompt
   * truncated.
   *
   * The rename outranks everything by design — a person naming a session must
   * not have it renamed under them by a model — which is also why the engine
   * title is *only ever read* while `meta.title` is unset (see
   * `#fetchEngineTitle`), rather than read and then discarded here.
   */
  #title(): string | undefined {
    const metaTitle = this.#config.meta?.title
    if (typeof metaTitle === 'string' && metaTitle.length > 0) {
      return metaTitle
    }
    if (this.#engineTitle) {
      return this.#engineTitle
    }
    const prompt = this.#config.prompt
    if (!prompt) {
      return undefined
    }
    return prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt
  }

  /** Host-facing rename: writes `meta.title`, which `#title()` prefers. Clearing
   * it (undefined) restores the derived title. The engine is never told. */
  setTitle(title: string | undefined): void {
    const meta = { ...this.#config.meta }
    if (title) {
      meta.title = title
    } else {
      delete meta.title
    }
    this.#config = { ...this.#config, meta }
  }

  /** Begin the session. Idempotent; returns the run promise (resolves when the query ends). */
  start(): Promise<void> {
    if (this.#started) {
      return this.#runPromise!
    }
    this.#started = true
    if (this.#config.prompt) {
      this.sendMessage(this.#config.prompt)
    }
    this.#runPromise = this.#run()
    return this.#runPromise
  }

  /** Queue a user message for the session (starts the next turn when idle).
   *
   * `attachments` carry their own bytes; they reach the CLI as content blocks and
   * are logged as references. A message may be attachments alone — an empty text
   * block is not valid API input, so the text is only added when there is some. */
  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#closed) {
      throw new Error('session is closed')
    }
    const blocks = attachments?.length ? attachmentContentBlocks(attachments) : []
    const content = blocks.length
      ? ([...blocks, ...(text ? [{ type: 'text', text }] : [])] as unknown as SDKUserMessage['message']['content'])
      : text
    this.#input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.#sdkSessionId,
    })
    // The SDK does not echo streamed-input user messages back, so the transcript
    // would never show them — emit the event here (the one place input enters).
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid: randomUUID(),
    })
  }

  /** Live MCP server status, straight from the CLI. Undefined when the engine
   * can't answer (an injected fake query in tests) — the caller 501s rather than
   * pretending the session has no servers. */
  async mcpServers(): Promise<McpServerStatusInfo[] | undefined> {
    const query = this.#query
    if (typeof query?.mcpServerStatus !== 'function') {
      return undefined
    }
    return (await query.mcpServerStatus()).map(mcpStatusInfo)
  }

  async reconnectMcpServer(name: string): Promise<void> {
    const query = this.#query
    if (typeof query?.reconnectMcpServer !== 'function') {
      throw new Error('this session cannot reconnect MCP servers')
    }
    await query.reconnectMcpServer(name)
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    const query = this.#query
    if (typeof query?.toggleMcpServer !== 'function') {
      throw new Error('this session cannot enable or disable MCP servers')
    }
    await query.toggleMcpServer(name, enabled)
  }

  /** Resolve a pending permission request. Returns false if the id is unknown (e.g. timed out). */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#pending.get(requestId)
    if (!pending) {
      return false
    }
    this.#settleApproval(requestId, pending, decision, 'client')
    return true
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt()
  }

  /**
   * Reset the conversation by sending the `/clear` the CLI already honors.
   *
   * Deliberately not a second mechanism: this engine's reset arrives *from the
   * SDK*, and `normalizeSdkMessage` turns the CLI's report of it into the
   * `conversation_reset` event (adopting the new conversation id and re-polling
   * context usage on the way through). Reimplementing the clear here would give
   * one engine two ways to reach the same state, and only one of them would get
   * the id adoption right. So the command and the composer's `/clear` are one
   * behaviour, and this method is the thin end of it.
   *
   * The one place it differs from the other two engines: this resolves when the
   * `/clear` has been **handed to the CLI**, not when the reset has happened —
   * the CLI queues its own streamed input, so waiting is its job, and there is
   * no chain here to ride. The observable contract is the same (a clear sent
   * mid-turn queues rather than cutting the turn short); only the moment the
   * promise settles is weaker, and no caller depends on it.
   */
  async clearContext(): Promise<void> {
    if (this.#status === 'closed' || this.#status === 'failed') {
      throw new Error('session is closed')
    }
    this.sendMessage('/clear')
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query?.setPermissionMode(mode)
    this.#permissionMode = mode
    this.#emit({ type: 'permission_mode_changed', mode })
  }

  /** Switch the model for subsequent responses; undefined = back to the default. */
  async setModel(model?: string): Promise<void> {
    await this.#query?.setModel(model)
    this.#model = model
    this.#emit({ type: 'model_changed', model })
  }

  /** Emit a session_error and terminate. For host-enforced policy (e.g. requireApiKey). */
  fail(message: string): void {
    if (this.#closed) {
      return
    }
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  /** Terminate the session and the underlying CLI subprocess. */
  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    for (const [id, pending] of this.#pending) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'Session closed' }, 'policy')
    }
    this.#input.end()
    this.#query?.close()
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
  }

  /** See `Runner.eventAt`. A linear scan: the one caller is a reader pressing
   * "show everything" on one row, so a per-runner seq index would be a map
   * maintained on every emit to save a walk nobody makes twice a minute. */
  eventAt(seq: number): SessionEvent | undefined {
    return this.#events.find((event) => event.seq === seq)
  }

  /**
   * Replay buffered events with seq > afterSeq, then deliver live events.
   * Returns an unsubscribe function.
   *
   * Replay honours the reset watermark: transcript content below the latest
   * `conversation_reset` is skipped (the reducer would clear it again anyway,
   * and a pre-reset client that never learned the reducer's case would render
   * a conversation the engine has discarded), while state-bearing events —
   * which are emitted once and never again — always replay. The reset event
   * itself replays (the skip is strictly-below), which is what clears a
   * reconnecting client still holding pre-reset rows; superseded resets are
   * content below the newer one and are skipped with what they cleared.
   */
  subscribe(listener: SessionEventListener, afterSeq = 0, options?: SubscribeOptions): () => void {
    return this.#subscribers.subscribe(this.#events, listener, afterSeq, options, this.#resetSeq)
  }

  async #run(): Promise<void> {
    const queryFn = this.#config.queryFn ?? (sdkQuery as QueryFn)
    try {
      await this.#backfillHistory()
      if (this.#closed) {
        return
      }
      this.#query = queryFn({ prompt: this.#input, options: this.#buildOptions() })
      // Without an initial prompt the CLI stays silent (no init handshake) until the
      // first message arrives, so 'starting' would never resolve — the session is
      // already accepting input, which is what 'idle' means. The control channel
      // does answer before init, though — fetch capabilities, a context baseline and
      // the plan's usage now so promptless sessions aren't blank until their first
      // turn. A session opened only to be watched may never have one.
      if (!this.#config.prompt) {
        this.#setStatus('idle')
        void this.#fetchCapabilities()
        void this.#fetchContextUsage()
        void this.#fetchRateLimits()
      }
      for await (const message of this.#query) {
        this.#handleMessage(message)
      }
      if (!this.#closed) {
        this.#closed = true
        this.#input.end()
        this.#emit({ type: 'session_closed', reason: 'server' })
        this.#setStatus('closed')
      }
    } catch (error) {
      if (!this.#closed) {
        this.#emit({
          type: 'session_error',
          message: error instanceof Error ? error.message : String(error),
        })
        this.#setStatus('failed')
        this.close('error')
      }
    }
  }

  /**
   * On resume, emit the prior session's transcript as replay events (seq'd before any
   * live event). The SDK only re-streams *user* messages on resume; assistant history
   * would otherwise be lost to clients attaching after a server restart. Duplicated
   * user messages are deduped client-side by uuid.
   */
  async #backfillHistory(): Promise<void> {
    const c = this.#config
    if (!c.resume || c.backfillHistory === false) {
      return
    }
    const historyFn = c.historyFn ?? ((sessionId: string, options: { dir?: string }) => getSessionMessages(sessionId, options))
    let messages: SessionMessage[]
    try {
      messages = await historyFn(c.resume, { dir: this.#cwd })
    } catch {
      // Best-effort: a missing/unreadable transcript must not block the resume itself.
      return
    }
    for (const m of messages) {
      if (this.#closed) {
        return
      }
      if (m.type === 'user') {
        const message = toApiMessage(m.message)
        this.#emit({
          type: 'user_message',
          message,
          parentToolUseId: m.parent_tool_use_id,
          replay: true,
          // The live path reads this off `isSynthetic` / `origin.kind`; a stored
          // message carries neither (see `isSyntheticUserText`), so the wrapper
          // text is the only thing left to read it from. Without it a resumed
          // session's `<task-notification>` blobs come back as blue user rows —
          // and, because `transcriptActivity` counts a non-synthetic user
          // message as a row, as unread badges for work nobody typed.
          synthetic: isSyntheticUserText(message) ? true : undefined,
          uuid: m.uuid,
        })
      } else if (m.type === 'assistant') {
        this.#emit({
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
    const c = this.#config
    const options: Options = {
      cwd: this.#cwd,
      permissionMode: c.permissionMode,
      allowedTools: c.allowedTools,
      disallowedTools: c.disallowedTools,
      mcpServers: c.mcpServers as Options['mcpServers'],
      settingSources: c.settingSources,
      model: c.model,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      resume: c.resume,
      forkSession: c.forkSession,
      // Open string on the wire; the SDK's union lags the CLI's vocabulary and
      // the CLI silently downgrades an effort the model doesn't support.
      effort: c.reasoningEffort as Options['effort'],
      includePartialMessages: c.includePartialMessages ?? true,
      // Without this the SDK forwards only a subagent's tool_use/tool_result
      // blocks — "enough for a heartbeat counter", in its own words — and its
      // prompt, thinking and final report never reach the stream at all. That
      // is not a rendering gap a client can close: a nested transcript with no
      // text in it is a list of tool names. On, therefore, because this surface
      // claims to be the session rather than a summary of it; a host that wants
      // the quieter stream sets it back through `extraOptions`, which is spread
      // last precisely so it can.
      forwardSubagentText: true,
      canUseTool: this.#canUseTool,
      env: c.env,
      pathToClaudeCodeExecutable: c.pathToClaudeCodeExecutable,
      // The CLI refuses to *switch into* bypassPermissions unless it was spawned
      // with the capability — smoke-verified: "Cannot set permission mode to
      // bypassPermissions because the session was not launched with
      // --dangerously-skip-permissions".
      ...(c.permissionMode === 'bypassPermissions' || c.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...c.extraOptions,
    }
    return options
  }

  #handleMessage(msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.#sdkSessionId = msg.session_id
      this.#model = msg.model
      this.#permissionMode = msg.permissionMode
      this.#apiKeySource = msg.apiKeySource
      this.#emit({
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
      this.#setStatus('running')
      void this.#fetchCapabilities()
      void this.#fetchContextUsage()
      void this.#fetchRateLimits()
      // A resumed thread usually already has one; a fresh one will not for a
      // turn or two, which is what the turn-end poll is for.
      void this.#fetchEngineTitle()
      return
    }
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      // Authoritative turn-over signal — but a pending approval outranks it for
      // *display*, which is not a reason to forget what it said. Remember, and
      // apply it when the approval settles.
      if (this.#pending.size > 0) {
        if (msg.state === 'idle') {
          this.#turnOverWhileBlocked = true
        } else if (msg.state === 'running') {
          this.#turnOverWhileBlocked = false
        }
        return
      }
      if (msg.state === 'idle') {
        this.#setStatus('idle')
      } else if (msg.state === 'running') {
        this.#setStatus('running')
      }
      return
    }
    const body = normalizeSdkMessage(msg)
    if (body) {
      this.#emit(body)
      if (body.type === 'conversation_reset') {
        // Same session, fresh conversation: adopt the new conversation id now
        // rather than waiting for the follow-up system_init (which only arrives
        // with the next prompt) — a dormant record written in between must
        // resume the fresh conversation, not replay the cleared one. The next
        // system_init stays authoritative and overwrites it.
        if (body.sdkSessionId) {
          this.#sdkSessionId = body.sdkSessionId
        }
        // The window now holds an almost-empty conversation; re-poll so clients
        // aren't left staring at the cleared conversation's reading.
        void this.#fetchContextUsage()
      }
      if (body.type === 'turn_result') {
        // total_cost_usd / num_turns are session-cumulative on each result message.
        this.#totalCostUsd = body.totalCostUsd
        this.#numTurns = body.numTurns
        // Fallback for SDK versions without session_state_changed, deferred
        // under a standing approval for the reason above.
        if (this.#pending.size === 0) {
          this.#setStatus('idle')
        } else {
          this.#turnOverWhileBlocked = true
        }
        // Context usage moves every turn; the poll is a cheap control request.
        void this.#fetchContextUsage()
        void this.#fetchRateLimits()
        void this.#fetchEngineTitle()
      }
    }
  }

  /** Ask the CLI what models/commands it supports and surface them as an event
   * (replayed to late attachers). Called eagerly for promptless sessions and again
   * on init — the flag keeps it a single emit. Optional-chained: injected fake
   * queries in tests may not implement these, and a failure must not affect the
   * session. */
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
      if (this.#closed || this.#capabilitiesEmitted) {
        return
      }
      this.#capabilitiesEmitted = true
      this.#emit({
        type: 'capabilities',
        models: modelOptionsFromSdk(models),
        defaultModel: defaultModelFromSdk(models),
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        })),
      })
    } catch {
      // Capabilities are best-effort decoration; the session works without them.
    }
  }

  /**
   * Adopt the title the CLI gave this thread — the "friendly title" it writes a
   * turn or two into a session, and the name a resumed thread already carries.
   *
   * A **poll, not an observation**, and unavoidably so: no member of the SDK's
   * `SDKMessage` union carries it (the whole union was checked). It lives on
   * `SDKSessionInfo`, which only `getSessionInfo` / `listSessions` return — the
   * same record `GET /sdk-sessions` already serves as `SdkSessionSummary`. So it
   * is read at init and after each turn, which is also roughly the rate at which
   * it changes.
   *
   * Two rules:
   * - **Never while `meta.title` is set.** A rename is a person's decision and a
   *   generated summary must not overwrite it. Not read at all in that case, so
   *   there is no stored value waiting to resurface if the rename is cleared —
   *   the next turn simply fetches it again.
   * - `summary` falls back to the first prompt when the session has no real
   *   title yet, so it is taken only when it *differs* from `firstPrompt`.
   *   Otherwise `#title()`'s own prompt fallback covers it, and the two would
   *   disagree only in how they truncate.
   *
   * Best-effort throughout: an unreadable transcript, a session file that is not
   * there yet, an SDK without the function — all leave the title as it was.
   */
  async #fetchEngineTitle(): Promise<void> {
    const metaTitle = this.#config.meta?.title
    if (typeof metaTitle === 'string' && metaTitle.length > 0) {
      return
    }
    const sdkSessionId = this.#sdkSessionId
    if (!sdkSessionId) {
      return
    }
    const read = this.#config.sessionInfoFn ?? getSessionInfo
    try {
      const info = await read(sdkSessionId, { dir: this.#cwd })
      if (this.#closed || !info) {
        return
      }
      const summary = info.summary && info.summary !== info.firstPrompt ? info.summary : undefined
      const title = info.customTitle || summary
      if (title) {
        this.#engineTitle = title
      }
    } catch {
      // The title is decoration; a session with none works exactly as well.
    }
  }

  /** Snapshot the context window after a turn and surface it as an event. Optional-chained
   * and best-effort for the same reasons as #fetchCapabilities. */
  async #fetchContextUsage(): Promise<void> {
    const query = this.#query
    if (typeof query?.getContextUsage !== 'function') {
      return
    }
    try {
      const usage = await query.getContextUsage()
      if (this.#closed) {
        return
      }
      this.#emit({
        type: 'context_usage',
        usage: {
          categories: usage.categories.map((c) => ({
            name: c.name,
            tokens: c.tokens,
            color: c.color,
          })),
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
        },
      })
    } catch {
      // Usage is best-effort decoration; the session works without it.
    }
  }

  /**
   * Snapshot the plan's rate-limit windows and surface them as `rate_limit`
   * events — the same event a live `rate_limit_event` produces, so clients need
   * nothing new to render it.
   *
   * The CLI only *pushes* a window when it changes, which for a session being
   * watched rather than driven can be never; polling is what makes usage show up
   * at all. The control request is marked experimental in the SDK, name included,
   * so it is probed for by name and every failure is silent — one more reason
   * this can only ever be decoration.
   */
  async #fetchRateLimits(): Promise<void> {
    const query = this.#query as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> } | undefined
    const fetchUsage = query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof fetchUsage !== 'function') {
      return
    }
    try {
      const usage = (await fetchUsage.call(query)) as UsageRateLimits
      if (this.#closed) {
        return
      }
      // The plan names the windows, so it goes out ahead of them — and only when
      // it changes, since this is polled after every turn and the answer is the
      // same one all session long.
      const subscriptionType = usage.subscription_type
      if (subscriptionType && subscriptionType !== this.#subscriptionType) {
        this.#subscriptionType = subscriptionType
        this.#emit({ type: 'plan_info', subscriptionType })
      }
      for (const body of rateLimitEventsFromUsage(usage)) {
        this.#emit(body)
      }
    } catch {
      // Best-effort, and experimental on top of that.
    }
  }

  #canUseTool: CanUseTool = (toolName, input, options) => {
    const id = randomUUID()
    const timeoutMs = this.#config.approvalTimeoutMs ?? this.#config.defaultApprovalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
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
      expiresAt: Date.now() + timeoutMs,
    }
    const questionBehavior = this.#config.questionBehavior ?? 'ask'
    if (toolName === 'AskUserQuestion' && questionBehavior !== 'ask') {
      delete request.expiresAt
      return Promise.resolve(this.#resolveQuestionByPolicy(request, questionBehavior))
    }
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#settleApproval(id, pending, { behavior: 'deny', message: 'Approval timed out' }, 'timeout')
        }
      }, timeoutMs)
      this.#pending.set(id, { request, resolve, timer })
      options.signal.addEventListener('abort', () => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#settleApproval(id, pending, { behavior: 'deny', message: 'Turn aborted' }, 'policy')
        }
      })
      this.#emit({ type: 'permission_requested', request })
      this.#setStatus('awaiting_approval')
    })
  }

  /** 'auto'/'deny' sessions settle AskUserQuestion synchronously instead of pending:
   * 'auto' picks each question's first (recommended) option, 'deny' sends the model
   * back to decide for itself. Request/resolved events still fire so transcripts and
   * job webhooks show what was chosen. */
  #resolveQuestionByPolicy(request: PermissionRequest, mode: 'auto' | 'deny'): PermissionResult {
    this.#emit({ type: 'permission_requested', request })
    if (mode === 'deny') {
      const message = 'Interactive questions are disabled for this session — choose the most reasonable option yourself and continue.'
      this.#emit({
        type: 'permission_resolved',
        requestId: request.id,
        behavior: 'deny',
        resolvedBy: 'policy',
        message,
      })
      return { behavior: 'deny', message, toolUseID: request.toolUseId }
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: request.id,
      behavior: 'allow',
      resolvedBy: 'policy',
    })
    return {
      behavior: 'allow',
      updatedInput: { ...request.input, answers: recommendedAnswers(request.input) },
      toolUseID: request.toolUseId,
    }
  }

  #settleApproval(id: string, pending: PendingApproval, decision: PermissionDecision, resolvedBy: 'client' | 'timeout' | 'policy'): void {
    clearTimeout(pending.timer)
    this.#pending.delete(id)
    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        // The SDK requires a record here even for an unmodified allow — echo the
        // original input back when the client didn't rewrite it.
        updatedInput: decision.updatedInput ?? pending.request.input,
        toolUseID: pending.request.toolUseId,
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: decision.message ?? 'Denied',
        interrupt: decision.interrupt,
        toolUseID: pending.request.toolUseId,
      })
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: id,
      behavior: decision.behavior,
      resolvedBy,
      message: decision.behavior === 'deny' ? (decision.message ?? 'Denied') : undefined,
    })
    if (this.#pending.size === 0) {
      // The deferred turn-over wins: this approval was the only thing standing
      // between the session and the truth. Consumed either way, so a later
      // approval in a live turn cannot inherit it.
      const endedWhileBlocked = this.#turnOverWhileBlocked
      this.#turnOverWhileBlocked = false
      if (endedWhileBlocked) {
        this.#setStatus('idle')
      } else if (this.#status === 'awaiting_approval') {
        this.#setStatus('running')
      }
    }
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#status === status && this.#statusDetail === detail) {
      return
    }
    // Terminal states win.
    if (this.#status === 'closed' || this.#status === 'failed') {
      return
    }
    this.#status = status
    this.#statusDetail = detail
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#lastActivityAt = event.ts
    // Rows, not events: what a client diffs to know how much it missed. The
    // count is monotonic across a conversation_reset on purpose — it is an
    // unread cursor, not an item count (see SessionInfo.activityCount).
    this.#activityCount += transcriptActivity(body)
    // The list's copy of the reading the transcript already has. Folded here
    // rather than at the point it is fetched, so every producer — and any
    // future one — passes through the same rule.
    this.#contextUsage = contextReading(body) ?? this.#contextUsage
    if (body.type === 'conversation_reset') {
      this.#resetSeq = event.seq
      // A reset retires the conversation the window described; the old fill is
      // not this conversation's, exactly as the transcript state clears it.
      this.#contextUsage = undefined
    }
    // Before fan-out, like #pending: a listener that reads info() on this very
    // event must see it already folded in.
    this.#subagents.observe(body, event.ts)
    this.#events.push(event)
    this.#subscribers.emit(event)
  }
}

/** Answer each AskUserQuestion question with its first option's label — the tool's
 * convention puts the recommended choice first. Keyed by question text, the shape the
 * CLI expects back in `updatedInput.answers`. */
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
