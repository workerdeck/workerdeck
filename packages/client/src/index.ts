import type {
  AttachedFrame,
  ClientFrame,
  CreateJobRequest,
  CreateProfileRequest,
  CreateSessionRequest,
  JobEvent,
  JobInfo,
  FindHostFilesResponse,
  GetProfileResponse,
  ListHostDirResponse,
  ListHostRootsResponse,
  ListProfilesResponse,
  ListSessionFilesResponse,
  McpServerActionRequest,
  McpServersResponse,
  McpServerStatusInfo,
  MessageAttachment,
  ReadHostFileResponse,
  UploadAttachmentResponse,
  WriteHostFileRequest,
  WriteHostFileResponse,
  PermissionMode,
  ProfileInfo,
  QueueServerFrame,
  QueueStats,
  ResolvePermissionRequest,
  UpdateSessionRequest,
  SubmitExecutionResultRequest,
  SubmitExecutionResultResponse,
  SaveProfileResponse,
  SdkSessionSummary,
  ServerFrame,
  SessionEvent,
  SessionFileInfo,
  SessionInfo,
  ToolCallRequestFrame,
  ToolExecutionOutput,
  UpdateProfileRequest,
} from '@workerdeck/protocol'

/** Whatever the ambient `fetch` accepts as a body — `Blob`/`File` in a browser,
 * `Uint8Array` or a string in Node. Derived rather than named (`BodyInit` is a
 * DOM-lib type, and this package compiles against both). */
export type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>

export type ClientOptions = {
  /** REST base, e.g. "http://127.0.0.1:8787/v1". The ws:// URL is derived from it. */
  baseUrl: string
  /** Extra headers for REST calls (auth). Browsers can't set WS headers — use
   * `buildWsUrl` (ticket query param) or cookies for WS auth. */
  headers?: Record<string, string>
  /** Override WS URL construction (auth tickets, proxies). */
  buildWsUrl?: (sessionId: string, afterSeq: number) => string
  /** Override the queue WS URL (`{baseUrl}/queue/ws` by default). */
  buildQueueWsUrl?: () => string
  /** Injectable for non-browser environments/tests. Defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket
  fetchImpl?: typeof fetch
}

/**
 * A REST call the gateway refused, carrying the status alongside the message.
 *
 * An `Error` subclass on purpose: every existing `e instanceof Error` check and
 * every `e.message` read keeps working unchanged. The status is what lets a
 * caller tell "this server doesn't have that route" (404 — stop asking) from
 * "that file was too big" (413 — tell the user), which a message string can't.
 */
export class WorkerDeckError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WorkerDeckError'
    this.status = status
  }
}

export type AttachOptions = {
  /** Replay events with seq greater than this. Default 0 (full replay). */
  afterSeq?: number
  /** Auto-reconnect with backoff on unexpected disconnects. Default true. */
  reconnect?: boolean
}

export type SessionHandleEvents = {
  /** Fired on every (re)attach with the server's session snapshot. */
  attached: AttachedFrame
  /** Every session event, replayed and live, in seq order. */
  event: SessionEvent
  protocolError: string
  /** WS connectivity: true on open, false on close. */
  connectionChange: boolean
  /**
   * A reconnect has been scheduled, carrying how many have failed in a row (1 on
   * the first). The handle retries forever, so "offline" is a judgement a UI makes
   * about how long it has been failing rather than a state reported here.
   */
  reconnectAttempt: number
  /**
   * The server is asking this client to execute a tool call in its own sandbox.
   * Answer with {@link SessionHandle.sendToolCallResult} or
   * {@link SessionHandle.sendToolCallError}, echoing the same `executionId`.
   * Ignoring it is safe: the server fails the execution at `expiresAt`.
   */
  toolCallRequest: ToolCallRequestFrame
  /** A bridged call no longer needs an answer (turn interrupted, timed out, or
   * the session closed) — abandon any work in progress for this executionId. */
  toolCallCanceled: { executionId: string; reason: string }
}

type Listener<T> = (payload: T) => void

export class SessionHandle {
  readonly sessionId: string
  #client: WorkerDeckClient
  #options: Required<Pick<AttachOptions, 'reconnect'>> & AttachOptions
  #ws: WebSocket | undefined
  #listeners = new Map<keyof SessionHandleEvents, Set<Listener<never>>>()
  #lastSeq: number
  #closed = false
  #retries = 0
  #outbox: string[] = []
  #connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(client: WorkerDeckClient, sessionId: string, options: AttachOptions = {}) {
    this.#client = client
    this.sessionId = sessionId
    this.#options = { reconnect: true, ...options }
    this.#lastSeq = options.afterSeq ?? 0
    // Deferred a tick so an attach that is detached in the same tick (React
    // StrictMode's throwaway dev mount) never opens a socket — closing a
    // WebSocket mid-upgrade breaks proxies (vite logs EPIPE) for nothing.
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  on<K extends keyof SessionHandleEvents>(
    kind: K,
    listener: Listener<SessionHandleEvents[K]>,
  ): () => void {
    let set = this.#listeners.get(kind)
    if (!set) {
      set = new Set()
      this.#listeners.set(kind, set)
    }
    set.add(listener as Listener<never>)
    return () => set.delete(listener as Listener<never>)
  }

  /** Send a message, optionally naming attachments uploaded ahead of it with
   * {@link WorkerDeckClient.uploadAttachment} (ids in the order they should reach
   * the model). An unknown id fails the whole command — the server will not send a
   * message that quietly lost its picture. */
  send(text: string, attachmentIds?: string[]): void {
    this.#sendFrame({
      type: 'user_message',
      text,
      attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
    })
  }

  approve(requestId: string, updatedInput?: Record<string, unknown>): void {
    this.#sendFrame({ type: 'permission_decision', requestId, behavior: 'allow', updatedInput })
  }

  deny(requestId: string, message?: string, interrupt?: boolean): void {
    this.#sendFrame({ type: 'permission_decision', requestId, behavior: 'deny', message, interrupt })
  }

  interrupt(): void {
    this.#sendFrame({ type: 'interrupt' })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#sendFrame({ type: 'set_permission_mode', mode })
  }

  /** Switch the model for subsequent responses; omit `model` for the default. */
  setModel(model?: string): void {
    this.#sendFrame({ type: 'set_model', model })
  }

  /** Answer a bridged tool call (see the `toolCallRequest` event). */
  sendToolCallResult(executionId: string, output: ToolExecutionOutput, logs?: string[]): void {
    this.#sendFrame({ type: 'tool_call_result', executionId, output, logs })
  }

  /** Report that a bridged tool call could not be executed. The failure is fed
   * to the model as tool output, so the agent can adapt rather than stall. */
  sendToolCallError(executionId: string, reason: string, error: string, logs?: string[]): void {
    this.#sendFrame({ type: 'tool_call_error', executionId, reason, error, logs })
  }

  /** Ask the server to terminate the session (the handle disconnects too). */
  closeSession(): void {
    this.#sendFrame({ type: 'close' })
    this.detach()
  }

  /** Skip the reconnect backoff and try again now — what a tab returning to the
   * foreground should do, rather than sitting out the remaining delay. No-op
   * while connected or after {@link SessionHandle.detach}. */
  reconnectNow(): void {
    if (this.#closed || (this.#ws && this.#ws.readyState === 1)) return
    clearTimeout(this.#connectTimer)
    this.#retries = 0
    this.#connect()
  }

  /** Disconnect this handle without touching the session. */
  detach(): void {
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#ws?.close()
    this.#ws = undefined
  }

  #emit<K extends keyof SessionHandleEvents>(kind: K, payload: SessionHandleEvents[K]): void {
    const set = this.#listeners.get(kind)
    if (!set) return
    for (const listener of set) {
      try {
        ;(listener as Listener<SessionHandleEvents[K]>)(payload)
      } catch {
        // listener errors must not break the stream
      }
    }
  }

  #sendFrame(frame: ClientFrame): void {
    const payload = JSON.stringify(frame)
    // readyState 1 === OPEN (avoid touching the WebSocket global; impl may be injected)
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(payload)
    else this.#outbox.push(payload)
  }

  #connect(): void {
    if (this.#closed) return
    const ws = this.#client.openSocket(this.sessionId, this.#lastSeq)
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#emit('connectionChange', true)
      for (const payload of this.#outbox.splice(0)) ws.send(payload)
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as ServerFrame
      if (frame.type === 'attached') {
        this.#emit('attached', frame)
      } else if (frame.type === 'event') {
        if (frame.event.seq <= this.#lastSeq) return
        this.#lastSeq = frame.event.seq
        this.#emit('event', frame.event)
      } else if (frame.type === 'tool_call_request') {
        this.#emit('toolCallRequest', frame)
      } else if (frame.type === 'tool_call_canceled') {
        this.#emit('toolCallCanceled', { executionId: frame.executionId, reason: frame.reason })
      } else if (frame.type === 'protocol_error') {
        this.#emit('protocolError', frame.message)
      }
    }
    ws.onclose = () => {
      this.#emit('connectionChange', false)
      if (this.#closed || !this.#options.reconnect) return
      const delay = Math.min(500 * 2 ** this.#retries++, 10_000)
      this.#emit('reconnectAttempt', this.#retries)
      this.#connectTimer = setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {
      // onclose follows; reconnect handled there
    }
  }
}

export type QueueHandleEvents = {
  /** Fired on every (re)attach with the server's current stats. */
  attached: QueueStats
  /** Every job lifecycle/progress event, live. */
  event: JobEvent
  /** Refreshed stats pushed after job lifecycle changes. */
  stats: QueueStats
  /** WS connectivity: true on open, false on close. */
  connectionChange: boolean
}

/**
 * Live view of the server's job queue over `{basePath}/queue/ws`. The stream is
 * read-only — submit/cancel stay on the REST methods. There is no replay: on
 * (re)connect, re-list jobs and treat the stream as updates from there.
 */
export class QueueHandle {
  #client: WorkerDeckClient
  #reconnect: boolean
  #ws: WebSocket | undefined
  #listeners = new Map<keyof QueueHandleEvents, Set<Listener<never>>>()
  #closed = false
  #retries = 0
  #connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(client: WorkerDeckClient, options: { reconnect?: boolean } = {}) {
    this.#client = client
    this.#reconnect = options.reconnect ?? true
    // Deferred a tick for the same StrictMode reason as SessionHandle.
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  on<K extends keyof QueueHandleEvents>(
    kind: K,
    listener: Listener<QueueHandleEvents[K]>,
  ): () => void {
    let set = this.#listeners.get(kind)
    if (!set) {
      set = new Set()
      this.#listeners.set(kind, set)
    }
    set.add(listener as Listener<never>)
    return () => set.delete(listener as Listener<never>)
  }

  detach(): void {
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#ws?.close()
    this.#ws = undefined
  }

  #emit<K extends keyof QueueHandleEvents>(kind: K, payload: QueueHandleEvents[K]): void {
    const set = this.#listeners.get(kind)
    if (!set) return
    for (const listener of set) {
      try {
        ;(listener as Listener<QueueHandleEvents[K]>)(payload)
      } catch {
        // listener errors must not break the stream
      }
    }
  }

  #connect(): void {
    if (this.#closed) return
    const ws = this.#client.openQueueSocket()
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#emit('connectionChange', true)
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as QueueServerFrame
      if (frame.type === 'queue_attached') {
        this.#emit('attached', frame.stats)
        this.#emit('stats', frame.stats)
      } else if (frame.type === 'job_event') {
        this.#emit('event', frame.event)
      } else if (frame.type === 'queue_stats') {
        this.#emit('stats', frame.stats)
      }
    }
    ws.onclose = () => {
      this.#emit('connectionChange', false)
      if (this.#closed || !this.#reconnect) return
      const delay = Math.min(500 * 2 ** this.#retries++, 10_000)
      this.#connectTimer = setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {
      // onclose follows; reconnect handled there
    }
  }
}

export class WorkerDeckClient {
  #options: ClientOptions
  #fetch: typeof fetch
  #WebSocketImpl: typeof WebSocket

  constructor(options: ClientOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis)
    this.#WebSocketImpl = options.WebSocketImpl ?? WebSocket
  }

  /**
   * Stable identity of the (gateway, principal) pair this client speaks as:
   * the base URL plus the auth headers it sends, order-insensitively.
   *
   * Exists for client-side caches that must survive the client *instance*
   * being rebuilt (a `useMemo` recreating it when a view switches gateways)
   * without ever sharing an entry across gateways — a session id is unique
   * only within one — or across credentials. Auth that rides outside
   * `headers` (a same-origin cookie, a fetch shim adding the key host-side)
   * is chosen per origin in every such host, so the base URL still separates
   * principals there; an embedder whose principal varies some other way on
   * one base URL should not key anything on this.
   */
  get identityKey(): string {
    const headers = Object.entries(this.#options.headers ?? {}).map(
      ([name, value]) => [name.toLowerCase(), value] as const,
    )
    headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify([this.#options.baseUrl, headers])
  }

  async createSession(request: CreateSessionRequest): Promise<SessionInfo> {
    const body = await this.#call('POST', '/sessions', request)
    return (body as { session: SessionInfo }).session
  }

  async listSessions(): Promise<SessionInfo[]> {
    const body = await this.#call('GET', '/sessions')
    return (body as { sessions: SessionInfo[] }).sessions
  }

  async getSession(id: string): Promise<SessionInfo> {
    const body = await this.#call('GET', `/sessions/${encodeURIComponent(id)}`)
    return (body as { session: SessionInfo }).session
  }

  /** Rename a session (or clear the name with `null`, restoring the derived
   * title). 409 when the session is parked. */
  async updateSession(id: string, patch: UpdateSessionRequest): Promise<SessionInfo> {
    const body = await this.#call('PATCH', `/sessions/${encodeURIComponent(id)}`, patch)
    return (body as { session: SessionInfo }).session
  }

  async deleteSession(id: string): Promise<SessionInfo> {
    const body = await this.#call('DELETE', `/sessions/${encodeURIComponent(id)}`)
    return (body as { session: SessionInfo }).session
  }

  /** List the files currently in a session's scratch filesystem (deliverables the
   * agent wrote; see the `file_delivered` event). 404s when the session's engine
   * has no file store (Claude-engine sessions). */
  async listSessionFiles(sessionId: string): Promise<SessionFileInfo[]> {
    const body = await this.#call('GET', `/sessions/${encodeURIComponent(sessionId)}/files`)
    return (body as ListSessionFilesResponse).files
  }

  /** Download one session file as text. */
  async fetchSessionFile(sessionId: string, path: string): Promise<string> {
    const res = await this.#fetch(this.sessionFileUrl(sessionId, path), {
      headers: this.#options.headers,
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(payload.error ?? `GET file failed with ${res.status}`, res.status)
    }
    return await res.text()
  }

  /**
   * Upload one file for the session, ahead of the message that will carry it.
   * The returned `id` goes to {@link SessionHandle.send}.
   *
   * The body is the raw bytes — no multipart — so anything `fetch` accepts as a
   * body works: a `File`/`Blob` from a picker, a `Uint8Array`, a string.
   */
  async uploadAttachment(
    sessionId: string,
    file: { name: string; mediaType: string; data: FetchBody },
  ): Promise<MessageAttachment> {
    const url = `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { ...this.#options.headers, 'content-type': file.mediaType },
      body: file.data,
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(payload.error ?? `upload failed with ${res.status}`, res.status)
    }
    return ((await res.json()) as UploadAttachmentResponse).attachment
  }

  /** Direct URL for an uploaded attachment — an `<img src>` on a cookie-authenticated
   * same-origin server. Header-authenticated clients must fetch it themselves. */
  attachmentUrl(sessionId: string, attachmentId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`
  }

  /**
   * Direct URL for a file the session's ENGINE produced on the host — the
   * `fileId` of a `file_produced` event. Same caveat as `attachmentUrl`: usable
   * as an `<img src>` only where the credential is a same-origin cookie; a
   * header-authenticated client (the phone) fetches it and makes its own blob.
   *
   * Unlike `/fs/read`, this needs no host-file roots and no raised byte cap —
   * see the `file_produced` note in the protocol for why that is sound.
   */
  producedFileUrl(sessionId: string, fileId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/produced/${encodeURIComponent(fileId)}`
  }

  /** Fetch a produced file's bytes. For clients that cannot put a credential on
   * an `<img src>`. Throws {@link WorkerDeckError} with the response status —
   * a 404 means the file is gone from disk, not that the route is missing. */
  async readProducedFile(sessionId: string, fileId: string): Promise<Blob> {
    const res = await this.#fetch(this.producedFileUrl(sessionId, fileId), {
      headers: { ...this.#options.headers },
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(
        payload.error ?? `produced file request failed with ${res.status}`,
        res.status,
      )
    }
    return await res.blob()
  }

  /** The session's MCP servers and their tools, live from the engine. 501 when the
   * session's engine has no MCP surface; 409 while the session is parked. */
  async listMcpServers(sessionId: string): Promise<McpServerStatusInfo[]> {
    const body = await this.#call('GET', `/sessions/${encodeURIComponent(sessionId)}/mcp`)
    return (body as McpServersResponse).servers
  }

  /** Reconnect, enable or disable one MCP server; answers with the refreshed list. */
  async mcpServerAction(
    sessionId: string,
    serverName: string,
    action: McpServerActionRequest['action'],
  ): Promise<McpServerStatusInfo[]> {
    const body = await this.#call(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(serverName)}`,
      { action },
    )
    return (body as McpServersResponse).servers
  }

  /** Direct download URL for a session file (e.g. an <a download> href). Carries
   * no headers — on authenticated servers, use fetchSessionFile instead. */
  sessionFileUrl(sessionId: string, path: string): string {
    const encoded = path
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/files/${encoded}`
  }

  /** Resolve a pending permission over REST — the remote-controller counterpart of the
   * WS `permission_decision` command (e.g. answering a job's AskUserQuestion from a
   * webhook consumer; the request rides on job_progress deliveries). Throws if the
   * request is unknown, already resolved, or expired. */
  async resolvePermission(
    sessionId: string,
    requestId: string,
    decision: ResolvePermissionRequest,
  ): Promise<void> {
    await this.#call(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      decision,
    )
  }

  /**
   * Deliver the result of a deferred tool execution — the callback a remote
   * worker (or a human) makes when the work a session parked on is done. The
   * session is rehydrated if its runner was torn down, and the agent loop
   * continues with this as the tool's output.
   *
   * Applied idempotently by `executionId`: a duplicate, or one racing the
   * execution watchdog, resolves with `applied: false` instead of applying twice.
   * Throws (404) when no session is waiting on that id.
   */
  async submitExecutionResult(
    executionId: string,
    result: SubmitExecutionResultRequest,
  ): Promise<SubmitExecutionResultResponse> {
    return (await this.#call(
      'POST',
      `/executions/${encodeURIComponent(executionId)}/result`,
      result,
    )) as SubmitExecutionResultResponse
  }

  /** List the profiles (named Claude Code config dirs) this server declares, filtered
   * to what the caller may use. Feed a result's `name` to createSession({ profile }).
   * Servers predating profiles 404 here — catch and treat as none declared. */
  /** The profiles this caller may use, plus whether it may create new ones.
   * Each profile carries `managed: true` when it is store-backed and therefore
   * editable; profiles declared in server options are not. */
  async listProfiles(): Promise<ListProfilesResponse> {
    return (await this.#call('GET', '/profiles')) as ListProfilesResponse
  }

  /** One profile plus a fresh, view-only snapshot of its config directory (settings,
   * skills, agents, commands — env var names only, never values). */
  async getProfile(name: string): Promise<GetProfileResponse> {
    return (await this.#call('GET', `/profiles/${encodeURIComponent(name)}`)) as GetProfileResponse
  }

  /**
   * Create a managed profile. Requires a server with a profile store and a
   * principal allowed to manage profiles; 409 if the name is already taken by a
   * managed or a startup-declared profile.
   */
  async createProfile(profile: CreateProfileRequest): Promise<ProfileInfo> {
    const body = await this.#call('POST', '/profiles', profile)
    return (body as SaveProfileResponse).profile
  }

  /** Merge into a managed profile. The name is the route: profiles cannot be
   * renamed, since sessions and jobs are already pinned to the old one. */
  async updateProfile(name: string, patch: UpdateProfileRequest): Promise<ProfileInfo> {
    const body = await this.#call('PATCH', `/profiles/${encodeURIComponent(name)}`, patch)
    return (body as SaveProfileResponse).profile
  }

  /** Delete a managed profile. Startup-declared profiles are refused (403) —
   * they live in the server's options. */
  async deleteProfile(name: string): Promise<void> {
    await this.#call('DELETE', `/profiles/${encodeURIComponent(name)}`)
  }

  /** List an engine's on-disk sessions (for resume across server restarts).
   * Feed a result's `sessionId` to createSession({ resume }) — under a profile
   * of the same engine. `profile` names whose store to list (claude profiles →
   * the Agent SDK store, codex profiles → CODEX_HOME threads); absent, the
   * server resolves it implicitly when it declares exactly one profile, else
   * lists the Claude engine's store. */
  async listSdkSessions(params?: {
    dir?: string
    limit?: number
    offset?: number
    profile?: string
  }): Promise<SdkSessionSummary[]> {
    const search = new URLSearchParams()
    if (params?.dir) search.set('dir', params.dir)
    if (params?.limit !== undefined) search.set('limit', String(params.limit))
    if (params?.offset !== undefined) search.set('offset', String(params.offset))
    if (params?.profile) search.set('profile', params.profile)
    const qs = search.size > 0 ? `?${search.toString()}` : ''
    const body = await this.#call('GET', `/sdk-sessions${qs}`)
    return (body as { sdkSessions: SdkSessionSummary[] }).sdkSessions
  }

  // -- Host filesystem (requires the server to be configured with `hostFiles`) -

  /**
   * The host directories this server will let a client browse, and whether it
   * accepts writes. Servers without host-file access configured 404 here — catch
   * and treat as "no file browser", the same way `listProfiles` handles an older
   * server.
   *
   * These are operator-privileged routes: the auth key is the whole authorization
   * story, and they bypass the agent permission flow entirely. See the protocol
   * package's `HostFileRoot` for why that framing is deliberate.
   */
  async listHostRoots(): Promise<ListHostRootsResponse> {
    return (await this.#call('GET', '/fs/roots')) as ListHostRootsResponse
  }

  /** One host directory, not recursive. Symlinks are reported as symlinks, never
   * followed here — read one to find out whether it resolves somewhere allowed. */
  async listHostDir(path: string): Promise<ListHostDirResponse> {
    const qs = `?path=${encodeURIComponent(path)}`
    return (await this.#call('GET', `/fs/list${qs}`)) as ListHostDirResponse
  }

  /** Recursive fuzzy file search under one host directory — the `@file` picker's
   * query. Cheap enough to call per keystroke: build directories are skipped and
   * the walk is bounded, truncating rather than erroring. */
  async findHostFiles(path: string, query = '', limit?: number): Promise<FindHostFilesResponse> {
    const search = new URLSearchParams({ path, q: query })
    if (limit !== undefined) search.set('limit', String(limit))
    return (await this.#call('GET', `/fs/find?${search.toString()}`)) as FindHostFilesResponse
  }

  /** Read one host file. Binary content comes back base64-encoded; the returned
   * `hash` is what a later `writeHostFile` needs as its `expectedHash`. */
  async readHostFile(path: string): Promise<ReadHostFileResponse> {
    const qs = `?path=${encodeURIComponent(path)}`
    return (await this.#call('GET', `/fs/read${qs}`)) as ReadHostFileResponse
  }

  /**
   * Write one host file, conditionally — always. Pass the `hash` from the read this
   * edit is based on; a 409 means the agent (or anything else) changed the file
   * underneath you, and the edit must be rebased rather than forced. Omit
   * `expectedHash` only to create a file that does not exist yet.
   */
  async writeHostFile(request: WriteHostFileRequest): Promise<WriteHostFileResponse> {
    return (await this.#call('PUT', '/fs/write', request)) as WriteHostFileResponse
  }

  // -- Job queue (requires the server to be configured with `queue`) ----------

  /** Schedule a one-shot run. The returned job's `sessionId` (once running) can be
   * fed to `attach()` to watch the run live. */
  async createJob(request: CreateJobRequest): Promise<JobInfo> {
    const body = await this.#call('POST', '/jobs', request)
    return (body as { job: JobInfo }).job
  }

  async listJobs(): Promise<JobInfo[]> {
    const body = await this.#call('GET', '/jobs')
    return (body as { jobs: JobInfo[] }).jobs
  }

  async getJob(id: string): Promise<JobInfo> {
    const body = await this.#call('GET', `/jobs/${encodeURIComponent(id)}`)
    return (body as { job: JobInfo }).job
  }

  /** Cancel a queued or running job. */
  async cancelJob(id: string): Promise<JobInfo> {
    const body = await this.#call('DELETE', `/jobs/${encodeURIComponent(id)}`)
    return (body as { job: JobInfo }).job
  }

  async queueStats(): Promise<QueueStats> {
    const body = await this.#call('GET', '/queue')
    return (body as { stats: QueueStats }).stats
  }

  attach(sessionId: string, options?: AttachOptions): SessionHandle {
    return new SessionHandle(this, sessionId, options)
  }

  /** Stream the job queue live (requires the server to be configured with `queue`).
   * Servers without a queue refuse the socket — check REST first or expect retries. */
  attachQueue(options?: { reconnect?: boolean }): QueueHandle {
    return new QueueHandle(this, options)
  }

  /** @internal used by SessionHandle */
  openSocket(sessionId: string, afterSeq: number): WebSocket {
    const url =
      this.#options.buildWsUrl?.(sessionId, afterSeq) ??
      `${this.#options.baseUrl.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(sessionId)}/ws?afterSeq=${afterSeq}`
    return new this.#WebSocketImpl(url)
  }

  /** @internal used by QueueHandle */
  openQueueSocket(): WebSocket {
    const url =
      this.#options.buildQueueWsUrl?.() ??
      `${this.#options.baseUrl.replace(/^http/, 'ws')}/queue/ws`
    return new this.#WebSocketImpl(url)
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#options.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.#options.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      throw new WorkerDeckError(payload.error ?? `${method} ${path} failed with ${res.status}`, res.status)
    }
    return payload
  }
}

export { apiUrl, isLoopbackHost } from './host-url.ts'
export type { HostUrl } from './host-url.ts'
export { hostAuth } from './host-auth.ts'
