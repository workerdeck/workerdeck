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
  ToolResultBlock,
} from '@workerdeck/protocol'

export type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>

export type ClientOptions = {
  baseUrl: string
  headers?: Record<string, string>
  buildWsUrl?: (sessionId: string, afterSeq: number, truncateResults?: boolean, imageRefs?: boolean) => string
  buildQueueWsUrl?: () => string
  WebSocketImpl?: typeof WebSocket
  fetchImpl?: typeof fetch
}

export class WorkerDeckError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WorkerDeckError'
    this.status = status
  }
}

export type AttachOptions = {
  afterSeq?: number
  reconnect?: boolean
  truncateResults?: boolean
  imageRefs?: boolean
}

export type SessionHandleEvents = {
  attached: AttachedFrame
  event: SessionEvent
  protocolError: string
  connectionChange: boolean
  reconnectAttempt: number
  toolCallRequest: ToolCallRequestFrame
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
    // Deferred a tick so a same-tick detach (React StrictMode's dev mount) never closes a WebSocket mid-upgrade, which breaks proxies.
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  on<K extends keyof SessionHandleEvents>(kind: K, listener: Listener<SessionHandleEvents[K]>): () => void {
    let set = this.#listeners.get(kind)
    if (!set) {
      set = new Set()
      this.#listeners.set(kind, set)
    }
    set.add(listener as Listener<never>)
    return () => set.delete(listener as Listener<never>)
  }

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

  clearContext(): void {
    this.#sendFrame({ type: 'clear_context' })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#sendFrame({ type: 'set_permission_mode', mode })
  }

  setModel(model?: string): void {
    this.#sendFrame({ type: 'set_model', model })
  }

  sendToolCallResult(executionId: string, output: ToolExecutionOutput, logs?: string[]): void {
    this.#sendFrame({ type: 'tool_call_result', executionId, output, logs })
  }

  sendToolCallError(executionId: string, reason: string, error: string, logs?: string[]): void {
    this.#sendFrame({ type: 'tool_call_error', executionId, reason, error, logs })
  }

  closeSession(): void {
    this.#sendFrame({ type: 'close' })
    this.detach()
  }

  reconnectNow(): void {
    if (this.#closed || (this.#ws && this.#ws.readyState === 1)) {
      return
    }
    clearTimeout(this.#connectTimer)
    this.#retries = 0
    this.#connect()
  }

  detach(): void {
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#ws?.close()
    this.#ws = undefined
  }

  #emit<K extends keyof SessionHandleEvents>(kind: K, payload: SessionHandleEvents[K]): void {
    const set = this.#listeners.get(kind)
    if (!set) {
      return
    }
    for (const listener of set) {
      try {
        ;(listener as Listener<SessionHandleEvents[K]>)(payload)
      } catch {}
    }
  }

  #sendFrame(frame: ClientFrame): void {
    const payload = JSON.stringify(frame)
    // readyState 1 === OPEN (avoid touching the WebSocket global; impl may be injected)
    if (this.#ws && this.#ws.readyState === 1) {
      this.#ws.send(payload)
    } else {
      this.#outbox.push(payload)
    }
  }

  #connect(): void {
    if (this.#closed) {
      return
    }
    const ws = this.#client.openSocket(this.sessionId, this.#lastSeq, this.#options.truncateResults, this.#options.imageRefs)
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#emit('connectionChange', true)
      for (const payload of this.#outbox.splice(0)) {
        ws.send(payload)
      }
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as ServerFrame
      if (frame.type === 'attached') {
        this.#emit('attached', frame)
      } else if (frame.type === 'event') {
        if (frame.event.seq <= this.#lastSeq) {
          return
        }
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
      if (this.#closed || !this.#options.reconnect) {
        return
      }
      const delay = Math.min(500 * 2 ** this.#retries++, 10_000)
      this.#emit('reconnectAttempt', this.#retries)
      this.#connectTimer = setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {}
  }
}

export type QueueHandleEvents = {
  attached: QueueStats
  event: JobEvent
  stats: QueueStats
  connectionChange: boolean
}

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

  on<K extends keyof QueueHandleEvents>(kind: K, listener: Listener<QueueHandleEvents[K]>): () => void {
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
    if (!set) {
      return
    }
    for (const listener of set) {
      try {
        ;(listener as Listener<QueueHandleEvents[K]>)(payload)
      } catch {}
    }
  }

  #connect(): void {
    if (this.#closed) {
      return
    }
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
      if (this.#closed || !this.#reconnect) {
        return
      }
      const delay = Math.min(500 * 2 ** this.#retries++, 10_000)
      this.#connectTimer = setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {}
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

  get identityKey(): string {
    const headers = Object.entries(this.#options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value] as const)
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

  async updateSession(id: string, patch: UpdateSessionRequest): Promise<SessionInfo> {
    const body = await this.#call('PATCH', `/sessions/${encodeURIComponent(id)}`, patch)
    return (body as { session: SessionInfo }).session
  }

  async deleteSession(id: string): Promise<SessionInfo> {
    const body = await this.#call('DELETE', `/sessions/${encodeURIComponent(id)}`)
    return (body as { session: SessionInfo }).session
  }

  async listSessionFiles(sessionId: string): Promise<SessionFileInfo[]> {
    const body = await this.#call('GET', `/sessions/${encodeURIComponent(sessionId)}/files`)
    return (body as ListSessionFilesResponse).files
  }

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

  async uploadAttachment(sessionId: string, file: { name: string; mediaType: string; data: FetchBody }): Promise<MessageAttachment> {
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

  attachmentUrl(sessionId: string, attachmentId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`
  }

  producedFileUrl(sessionId: string, fileId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/produced/${encodeURIComponent(fileId)}`
  }

  async readProducedFile(sessionId: string, fileId: string): Promise<Blob> {
    const res = await this.#fetch(this.producedFileUrl(sessionId, fileId), {
      headers: { ...this.#options.headers },
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(payload.error ?? `produced file request failed with ${res.status}`, res.status)
    }
    return await res.blob()
  }

  projectIconUrl(sessionId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/project/icon`
  }

  async projectIcon(sessionId: string): Promise<Blob> {
    const res = await this.#fetch(this.projectIconUrl(sessionId), {
      headers: { ...this.#options.headers },
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(payload.error ?? `project icon request failed with ${res.status}`, res.status)
    }
    return await res.blob()
  }

  async listMcpServers(sessionId: string): Promise<McpServerStatusInfo[]> {
    const body = await this.#call('GET', `/sessions/${encodeURIComponent(sessionId)}/mcp`)
    return (body as McpServersResponse).servers
  }

  async mcpServerAction(sessionId: string, serverName: string, action: McpServerActionRequest['action']): Promise<McpServerStatusInfo[]> {
    const body = await this.#call('POST', `/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(serverName)}`, { action })
    return (body as McpServersResponse).servers
  }

  sessionFileUrl(sessionId: string, path: string): string {
    const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/files/${encoded}`
  }

  async resolvePermission(sessionId: string, requestId: string, decision: ResolvePermissionRequest): Promise<void> {
    await this.#call('POST', `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`, decision)
  }

  async submitExecutionResult(executionId: string, result: SubmitExecutionResultRequest): Promise<SubmitExecutionResultResponse> {
    return (await this.#call('POST', `/executions/${encodeURIComponent(executionId)}/result`, result)) as SubmitExecutionResultResponse
  }

  async listProfiles(): Promise<ListProfilesResponse> {
    return (await this.#call('GET', '/profiles')) as ListProfilesResponse
  }

  async getProfile(name: string): Promise<GetProfileResponse> {
    return (await this.#call('GET', `/profiles/${encodeURIComponent(name)}`)) as GetProfileResponse
  }

  async createProfile(profile: CreateProfileRequest): Promise<ProfileInfo> {
    const body = await this.#call('POST', '/profiles', profile)
    return (body as SaveProfileResponse).profile
  }

  async updateProfile(name: string, patch: UpdateProfileRequest): Promise<ProfileInfo> {
    const body = await this.#call('PATCH', `/profiles/${encodeURIComponent(name)}`, patch)
    return (body as SaveProfileResponse).profile
  }

  async deleteProfile(name: string): Promise<void> {
    await this.#call('DELETE', `/profiles/${encodeURIComponent(name)}`)
  }

  async listSdkSessions(params?: { dir?: string; limit?: number; offset?: number; profile?: string }): Promise<SdkSessionSummary[]> {
    const search = new URLSearchParams()
    if (params?.dir) {
      search.set('dir', params.dir)
    }
    if (params?.limit !== undefined) {
      search.set('limit', String(params.limit))
    }
    if (params?.offset !== undefined) {
      search.set('offset', String(params.offset))
    }
    if (params?.profile) {
      search.set('profile', params.profile)
    }
    const qs = search.size > 0 ? `?${search.toString()}` : ''
    const body = await this.#call('GET', `/sdk-sessions${qs}`)
    return (body as { sdkSessions: SdkSessionSummary[] }).sdkSessions
  }

  async listHostRoots(): Promise<ListHostRootsResponse> {
    return (await this.#call('GET', '/fs/roots')) as ListHostRootsResponse
  }

  async listHostDir(path: string): Promise<ListHostDirResponse> {
    const qs = `?path=${encodeURIComponent(path)}`
    return (await this.#call('GET', `/fs/list${qs}`)) as ListHostDirResponse
  }

  async findHostFiles(path: string, query = '', limit?: number): Promise<FindHostFilesResponse> {
    const search = new URLSearchParams({ path, q: query })
    if (limit !== undefined) {
      search.set('limit', String(limit))
    }
    return (await this.#call('GET', `/fs/find?${search.toString()}`)) as FindHostFilesResponse
  }

  async readHostFile(path: string): Promise<ReadHostFileResponse> {
    const qs = `?path=${encodeURIComponent(path)}`
    return (await this.#call('GET', `/fs/read${qs}`)) as ReadHostFileResponse
  }

  async writeHostFile(request: WriteHostFileRequest): Promise<WriteHostFileResponse> {
    return (await this.#call('PUT', '/fs/write', request)) as WriteHostFileResponse
  }

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

  attachQueue(options?: { reconnect?: boolean }): QueueHandle {
    return new QueueHandle(this, options)
  }

  openSocket(sessionId: string, afterSeq: number, truncateResults = false, imageRefs = false): WebSocket {
    const query = `afterSeq=${afterSeq}` + (truncateResults ? '&truncateResults=1' : '') + (imageRefs ? '&imageRefs=1' : '')
    const url =
      this.#options.buildWsUrl?.(sessionId, afterSeq, truncateResults, imageRefs) ??
      `${this.#options.baseUrl.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(sessionId)}/ws?${query}`
    return new this.#WebSocketImpl(url)
  }

  async toolResult(
    sessionId: string,
    seq: number,
    toolUseId: string,
    options?: { imageRefs?: boolean },
  ): Promise<{ seq: number; toolUseId: string; content: ToolResultBlock['content']; isError: boolean }> {
    return (await this.#call(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/events/${seq}/result?toolUseId=${encodeURIComponent(toolUseId)}` +
        (options?.imageRefs ? '&imageRefs=1' : ''),
    )) as { seq: number; toolUseId: string; content: ToolResultBlock['content']; isError: boolean }
  }

  async toolResultImage(sessionId: string, seq: number, toolUseId: string, partIndex: number): Promise<Blob> {
    const path =
      `/sessions/${encodeURIComponent(sessionId)}/events/${seq}/result` + `?toolUseId=${encodeURIComponent(toolUseId)}&part=${partIndex}`
    const res = await this.#fetch(`${this.#options.baseUrl}${path}`, {
      headers: { ...this.#options.headers },
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(payload.error ?? `image part request failed with ${res.status}`, res.status)
    }
    return await res.blob()
  }

  openQueueSocket(): WebSocket {
    const url = this.#options.buildQueueWsUrl?.() ?? `${this.#options.baseUrl.replace(/^http/, 'ws')}/queue/ws`
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
