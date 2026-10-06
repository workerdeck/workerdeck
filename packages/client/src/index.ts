import type {
  AgentInfo,
  AgentResponse,
  CreateAgentRequest,
  RetireAgentRequest,
  UpdateAgentRequest,
  CreateJobRequest,
  CreateProfileRequest,
  CreateSessionRequest,
  JobInfo,
  FindHostFilesResponse,
  GatewayMeta,
  GetProfileResponse,
  ListHostDirResponse,
  ListHostRootsResponse,
  ListProfilesResponse,
  ListSessionFilesResponse,
  McpServerActionRequest,
  McpServersResponse,
  McpServerStatusInfo,
  PeerSessionSummary,
  PeerSessionsResponse,
  MessageAttachment,
  ReadHostFileResponse,
  UploadAttachmentResponse,
  WriteHostFileRequest,
  WriteHostFileResponse,
  ProfileInfo,
  QueueStats,
  ResolvePermissionRequest,
  ShellInfo,
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
import { sessionWsUrl } from './ws-url.ts'

type ToolResultResponse = { seq: number; toolUseId: string; content: ToolResultBlock['content']; isError: boolean }

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
    return await this.#pick('POST', '/sessions', 'session', request)
  }

  async listSessions(): Promise<SessionInfo[]> {
    return await this.#pick('GET', '/sessions', 'sessions')
  }

  async getSession(id: string): Promise<SessionInfo> {
    return await this.#pick('GET', this.#sess(id), 'session')
  }

  async updateSession(id: string, patch: UpdateSessionRequest): Promise<SessionInfo> {
    return await this.#pick('PATCH', this.#sess(id), 'session', patch)
  }

  async sleepSession(id: string): Promise<SessionInfo> {
    return await this.#pick('POST', this.#sess(id, '/sleep'), 'session')
  }

  async deleteSession(id: string): Promise<SessionInfo> {
    return await this.#pick('DELETE', this.#sess(id), 'session')
  }

  async listSessionFiles(sessionId: string): Promise<SessionFileInfo[]> {
    return await this.#pick<ListSessionFilesResponse['files']>('GET', this.#sess(sessionId, '/files'), 'files')
  }

  async fetchSessionFile(sessionId: string, path: string): Promise<string> {
    const res = await this.#callRaw(this.sessionFileUrl(sessionId, path), { headers: this.#options.headers }, 'GET file failed')
    return await res.text()
  }

  async uploadAttachment(sessionId: string, file: { name: string; mediaType: string; data: FetchBody }): Promise<MessageAttachment> {
    const url = `${this.#options.baseUrl}${this.#sess(sessionId, '/attachments')}?name=${encodeURIComponent(file.name)}`
    const res = await this.#callRaw(
      url,
      { method: 'POST', headers: { ...this.#options.headers, 'content-type': file.mediaType }, body: file.data },
      'upload failed',
    )
    return ((await res.json()) as UploadAttachmentResponse).attachment
  }

  attachmentUrl(sessionId: string, attachmentId: string): string {
    return `${this.#options.baseUrl}${this.#sess(sessionId, `/attachments/${encodeURIComponent(attachmentId)}`)}`
  }

  producedFileUrl(sessionId: string, fileId: string): string {
    return `${this.#options.baseUrl}${this.#sess(sessionId, `/produced/${encodeURIComponent(fileId)}`)}`
  }

  async readProducedFile(sessionId: string, fileId: string): Promise<Blob> {
    return await this.#blob(this.producedFileUrl(sessionId, fileId), 'produced file request failed')
  }

  projectIconUrl(sessionId: string): string {
    return `${this.#options.baseUrl}${this.#sess(sessionId, '/project/icon')}`
  }

  async projectIcon(sessionId: string): Promise<Blob> {
    return await this.#blob(this.projectIconUrl(sessionId), 'project icon request failed')
  }

  // Operator-only: a gateway without agents, or a scoped caller, answers 404.
  async listAgents(): Promise<AgentInfo[]> {
    return await this.#pick('GET', '/agents', 'agents')
  }

  async createAgent(request: CreateAgentRequest): Promise<AgentResponse> {
    return await this.#call('POST', '/agents', request)
  }

  async updateAgent(id: string, patch: UpdateAgentRequest): Promise<AgentResponse> {
    return await this.#call('PATCH', this.#agent(id), patch)
  }

  async restartAgent(id: string, prompt?: string): Promise<AgentResponse> {
    return await this.#call('POST', this.#agent(id, '/restart'), prompt === undefined ? {} : { prompt })
  }

  async retireAgent(id: string, request: RetireAgentRequest = {}): Promise<{ retired: string[]; released: string[] }> {
    return await this.#call('DELETE', this.#agent(id), request)
  }

  // A new avatar for the agent: `seed` picks a known one (a preview's), none rolls a random one.
  async changeAgentAvatar(id: string, seed?: string): Promise<AgentResponse> {
    return await this.#call('POST', this.#agent(id, '/avatar'), seed === undefined ? {} : { seed })
  }

  agentAvatarPreviewUrl(id: string, seed: string): string {
    return `${this.#options.baseUrl}${this.#agent(id, `/avatar-preview.png?seed=${encodeURIComponent(seed)}`)}`
  }

  async agentAvatarPreview(id: string, seed: string): Promise<Blob> {
    const res = await this.#callRaw(this.agentAvatarPreviewUrl(id, seed), { headers: { ...this.#options.headers } }, 'avatar preview request failed')
    return await res.blob()
  }

  agentAvatarUrl(id: string, busy = false): string {
    return `${this.#options.baseUrl}${this.#agent(id, busy ? '/avatar-busy.png' : '/avatar.png')}`
  }

  // `durations` is set on the busy strip only: one entry per frame, frames laid out left to right.
  async agentAvatar(id: string, busy = false): Promise<{ blob: Blob; durations?: number[] }> {
    const res = await this.#callRaw(this.agentAvatarUrl(id, busy), { headers: { ...this.#options.headers } }, 'agent avatar request failed')
    const header = res.headers.get('x-frame-durations')
    const durations = header
      ? header
          .split(',')
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0)
      : undefined
    return durations?.length ? { blob: await res.blob(), durations } : { blob: await res.blob() }
  }

  // The sessions this one may address, relay included: what its `peers_list` tool answers.
  async listPeers(sessionId: string): Promise<PeerSessionSummary[]> {
    return await this.#pick<PeerSessionsResponse['peers']>('GET', this.#sess(sessionId, '/peers'), 'peers')
  }

  async listMcpServers(sessionId: string): Promise<McpServerStatusInfo[]> {
    return await this.#pick<McpServersResponse['servers']>('GET', this.#sess(sessionId, '/mcp'), 'servers')
  }

  async mcpServerAction(sessionId: string, serverName: string, action: McpServerActionRequest['action']): Promise<McpServerStatusInfo[]> {
    const path = this.#sess(sessionId, `/mcp/${encodeURIComponent(serverName)}`)
    return await this.#pick<McpServersResponse['servers']>('POST', path, 'servers', { action })
  }

  sessionFileUrl(sessionId: string, path: string): string {
    const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return `${this.#options.baseUrl}${this.#sess(sessionId, `/files/${encoded}`)}`
  }

  async resolvePermission(sessionId: string, requestId: string, decision: ResolvePermissionRequest): Promise<void> {
    await this.#call('POST', this.#sess(sessionId, `/permissions/${encodeURIComponent(requestId)}`), decision)
  }

  async submitExecutionResult(executionId: string, result: SubmitExecutionResultRequest): Promise<SubmitExecutionResultResponse> {
    return await this.#call('POST', `/executions/${encodeURIComponent(executionId)}/result`, result)
  }

  async listProfiles(): Promise<ListProfilesResponse> {
    return await this.#call('GET', '/profiles')
  }

  async getProfile(name: string): Promise<GetProfileResponse> {
    return await this.#call('GET', `/profiles/${encodeURIComponent(name)}`)
  }

  async createProfile(profile: CreateProfileRequest): Promise<ProfileInfo> {
    return await this.#pick<SaveProfileResponse['profile']>('POST', '/profiles', 'profile', profile)
  }

  async updateProfile(name: string, patch: UpdateProfileRequest): Promise<ProfileInfo> {
    return await this.#pick<SaveProfileResponse['profile']>('PATCH', `/profiles/${encodeURIComponent(name)}`, 'profile', patch)
  }

  async deleteProfile(name: string): Promise<void> {
    await this.#call('DELETE', `/profiles/${encodeURIComponent(name)}`)
  }

  async listSdkSessions(params?: { dir?: string; limit?: number; offset?: number; profile?: string }): Promise<SdkSessionSummary[]> {
    const qs = query({ dir: params?.dir || undefined, limit: params?.limit, offset: params?.offset, profile: params?.profile || undefined })
    return await this.#pick('GET', `/sdk-sessions${qs}`, 'sdkSessions')
  }

  async listHostRoots(): Promise<ListHostRootsResponse> {
    return await this.#call('GET', '/fs/roots')
  }

  async meta(): Promise<GatewayMeta> {
    return await this.#call('GET', '/meta')
  }

  async listHostDir(path: string): Promise<ListHostDirResponse> {
    return await this.#call('GET', `/fs/list${query({ path })}`)
  }

  async findHostFiles(path: string, q = '', limit?: number): Promise<FindHostFilesResponse> {
    return await this.#call('GET', `/fs/find${query({ path, q, limit })}`)
  }

  async readHostFile(path: string): Promise<ReadHostFileResponse> {
    return await this.#call('GET', `/fs/read${query({ path })}`)
  }

  async writeHostFile(request: WriteHostFileRequest): Promise<WriteHostFileResponse> {
    return await this.#call('PUT', '/fs/write', request)
  }

  async createJob(request: CreateJobRequest): Promise<JobInfo> {
    return await this.#pick('POST', '/jobs', 'job', request)
  }

  async listJobs(): Promise<JobInfo[]> {
    return await this.#pick('GET', '/jobs', 'jobs')
  }

  async getJob(id: string): Promise<JobInfo> {
    return await this.#pick('GET', `/jobs/${encodeURIComponent(id)}`, 'job')
  }

  async cancelJob(id: string): Promise<JobInfo> {
    return await this.#pick('DELETE', `/jobs/${encodeURIComponent(id)}`, 'job')
  }

  async queueStats(): Promise<QueueStats> {
    return await this.#pick('GET', '/queue', 'stats')
  }

  async listShells(sessionId: string): Promise<ShellInfo[]> {
    return await this.#pick('GET', this.#sess(sessionId, '/shells'), 'shells')
  }

  async getShell(sessionId: string, shellId: string): Promise<ShellInfo> {
    return await this.#pick('GET', this.#shell(sessionId, shellId), 'shell')
  }

  async shellOutput(sessionId: string, shellId: string, options?: { view?: 'text' | 'raw' | 'screen'; tail?: number }): Promise<string> {
    const qs = query({ view: options?.view || undefined, tail: options?.tail })
    const res = await this.#callRaw(
      `${this.#options.baseUrl}${this.#shell(sessionId, shellId, `/output${qs}`)}`,
      { headers: { ...this.#options.headers } },
      'shell output request failed',
    )
    return await res.text()
  }

  async killShell(sessionId: string, shellId: string): Promise<ShellInfo> {
    return await this.#pick('POST', this.#shell(sessionId, shellId, '/kill'), 'shell')
  }

  async stopTask(sessionId: string, toolUseId: string): Promise<void> {
    await this.#call('POST', this.#sess(sessionId, `/tasks/${encodeURIComponent(toolUseId)}/stop`))
  }

  async backgroundTask(sessionId: string, toolUseId?: string): Promise<void> {
    const path = toolUseId === undefined ? '/tasks/background' : `/tasks/${encodeURIComponent(toolUseId)}/background`
    await this.#call('POST', this.#sess(sessionId, path))
  }

  async setShellAgentWrite(sessionId: string, shellId: string, enabled: boolean): Promise<ShellInfo> {
    return await this.#pick('POST', this.#shell(sessionId, shellId, '/agent-write'), 'shell', { enabled })
  }

  attach(sessionId: string, options?: AttachOptions): SessionHandle {
    return new SessionHandle(this, sessionId, options)
  }

  attachQueue(options?: { reconnect?: boolean }): QueueHandle {
    return new QueueHandle(this, options)
  }

  openSocket(sessionId: string, afterSeq: number, truncateResults = false, imageRefs = false): WebSocket {
    const url =
      this.#options.buildWsUrl?.(sessionId, afterSeq, truncateResults, imageRefs) ??
      sessionWsUrl(this.#options.baseUrl, sessionId, afterSeq, truncateResults, imageRefs)
    return new this.#WebSocketImpl(url)
  }

  async toolResult(sessionId: string, seq: number, toolUseId: string, options?: { imageRefs?: boolean }): Promise<ToolResultResponse> {
    return await this.#call(
      'GET',
      this.#sess(sessionId, `/events/${seq}/result${query({ toolUseId, imageRefs: options?.imageRefs ? 1 : undefined })}`),
    )
  }

  async toolResultImage(sessionId: string, seq: number, toolUseId: string, partIndex: number): Promise<Blob> {
    const url = `${this.#options.baseUrl}${this.#sess(sessionId, `/events/${seq}/result${query({ toolUseId, part: partIndex })}`)}`
    return await this.#blob(url, 'image part request failed')
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

  #sess(sessionId: string, suffix = ''): string {
    return `/sessions/${encodeURIComponent(sessionId)}${suffix}`
  }

  #agent(id: string, suffix = ''): string {
    return `/agents/${encodeURIComponent(id)}${suffix}`
  }

  #shell(sessionId: string, shellId: string, suffix = ''): string {
    return this.#sess(sessionId, `/shells/${encodeURIComponent(shellId)}${suffix}`)
  }

  async #blob(url: string, failure: string): Promise<Blob> {
    const res = await this.#callRaw(url, { headers: { ...this.#options.headers } }, failure)
    return await res.blob()
  }

  async #pick<T>(method: string, path: string, key: string, body?: unknown): Promise<T> {
    const payload = await this.#call<Record<string, T>>(method, path, body)
    return payload[key]!
  }

  async #call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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
    return payload as T
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(name, String(value))
    }
  }
  return search.size > 0 ? `?${search.toString()}` : ''
}

export { SessionHandle } from './session-handle.ts'
export type { AttachOptions, SessionHandleEvents } from './session-handle.ts'
export { QueueHandle } from './queue-handle.ts'
export type { QueueHandleEvents } from './queue-handle.ts'
export { apiUrl, isLoopbackHost } from './host-url.ts'
export type { HostUrl } from './host-url.ts'
export { hostAuth } from './host-auth.ts'
