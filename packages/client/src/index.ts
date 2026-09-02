import type {
  CreateJobRequest,
  CreateProfileRequest,
  CreateSessionRequest,
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
  ProfileInfo,
  QueueStats,
  ResolvePermissionRequest,
  UpdateSessionRequest,
  SubmitExecutionResultRequest,
  SubmitExecutionResultResponse,
  SaveProfileResponse,
  SdkSessionSummary,
  SessionFileInfo,
  SessionInfo,
  UpdateProfileRequest,
  ToolResultBlock,
} from '@workerdeck/protocol'
import { SessionHandle, type AttachOptions } from './session-handle.ts'
import { QueueHandle } from './queue-handle.ts'

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
    const res = await this.#callRaw(this.sessionFileUrl(sessionId, path), { headers: this.#options.headers }, 'GET file failed')
    return await res.text()
  }

  async uploadAttachment(sessionId: string, file: { name: string; mediaType: string; data: FetchBody }): Promise<MessageAttachment> {
    const url = `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/attachments?name=${encodeURIComponent(file.name)}`
    const res = await this.#callRaw(
      url,
      { method: 'POST', headers: { ...this.#options.headers, 'content-type': file.mediaType }, body: file.data },
      'upload failed',
    )
    return ((await res.json()) as UploadAttachmentResponse).attachment
  }

  attachmentUrl(sessionId: string, attachmentId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`
  }

  producedFileUrl(sessionId: string, fileId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/produced/${encodeURIComponent(fileId)}`
  }

  async readProducedFile(sessionId: string, fileId: string): Promise<Blob> {
    const res = await this.#callRaw(
      this.producedFileUrl(sessionId, fileId),
      { headers: { ...this.#options.headers } },
      'produced file request failed',
    )
    return await res.blob()
  }

  projectIconUrl(sessionId: string): string {
    return `${this.#options.baseUrl}/sessions/${encodeURIComponent(sessionId)}/project/icon`
  }

  async projectIcon(sessionId: string): Promise<Blob> {
    const res = await this.#callRaw(
      this.projectIconUrl(sessionId),
      { headers: { ...this.#options.headers } },
      'project icon request failed',
    )
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
    const res = await this.#callRaw(
      `${this.#options.baseUrl}${path}`,
      { headers: { ...this.#options.headers } },
      'image part request failed',
    )
    return await res.blob()
  }

  openQueueSocket(): WebSocket {
    const url = this.#options.buildQueueWsUrl?.() ?? `${this.#options.baseUrl.replace(/^http/, 'ws')}/queue/ws`
    return new this.#WebSocketImpl(url)
  }

  // The byte-serving routes' shared failure arm: `#call` owns the same rule for JSON routes.
  async #callRaw(url: string, init: NonNullable<Parameters<typeof fetch>[1]>, failure: string): Promise<Response> {
    const res = await this.#fetch(url, init)
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      throw new WorkerDeckError(payload.error ?? `${failure} with ${res.status}`, res.status)
    }
    return res
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

export { SessionHandle } from './session-handle.ts'
export type { AttachOptions, SessionHandleEvents } from './session-handle.ts'
export { QueueHandle } from './queue-handle.ts'
export type { QueueHandleEvents } from './queue-handle.ts'
export { apiUrl, isLoopbackHost } from './host-url.ts'
export type { HostUrl } from './host-url.ts'
export { hostAuth } from './host-auth.ts'
