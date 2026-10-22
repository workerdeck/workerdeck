import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, transcriptActivity, transcriptProse, type SessionEvent, type SessionEventBody, type SessionInfo } from '@workerdeck/protocol'

// A resumable engine stand-in: names its session on start, sends `prompt` like the real engines, and can be held busy.
export class EngineRunner implements Runner {
  readonly id: string
  readonly pendingApprovals = []
  readonly createdAt = Date.now()
  readonly sent: string[] = []
  #status: SessionInfo['status'] = 'starting'
  #events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0
  #sdkSessionId: string | undefined

  constructor(
    id: string,
    readonly config: SessionRunnerConfig,
  ) {
    this.id = id
  }

  hold: Promise<void> | undefined
  failStart: string | undefined
  // Names no engine conversation until its first message, like an engine started without a prompt.
  nameless = false

  async start(): Promise<void> {
    await this.hold
    if (this.failStart !== undefined) {
      this.#emit({ type: 'session_error', message: this.failStart })
      this.#status = 'failed'
      this.#emit({ type: 'status_changed', status: 'failed' })
      return
    }
    if (this.nameless && !this.config.resume && !this.config.prompt) {
      this.#status = 'idle'
      this.#emit({ type: 'status_changed', status: 'idle' })
      return
    }
    this.#name()
    if (this.config.prompt) {
      this.sendMessage(this.config.prompt)
    }
    this.#status = 'idle'
    this.#emit({ type: 'status_changed', status: 'idle' })
  }

  #name(): void {
    this.#sdkSessionId = this.config.resume ?? `engine-${this.id}`
    this.#emit({
      type: 'system_init',
      sdkSessionId: this.#sdkSessionId,
      model: 'test-model',
      cwd: this.config.cwd ?? '',
      apiKeySource: 'user',
      tools: [],
      skills: [],
      slashCommands: [],
      permissionMode: 'default',
      claudeCodeVersion: 'test',
      mcpServers: [],
    })
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.config.cwd ?? '',
      profile: this.config.profile,
      engine: 'provider',
      capabilities: { ...ENGINE_CAPABILITIES.provider, resume: true, resumeBackfill: true },
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      title: 'Archived talk',
      ...(this.config.epoch === undefined ? {} : { epoch: this.config.epoch }),
      ...this.#counts(),
    }
  }

  // The core runner's rule: the log's own counts on top of the base the gateway built this conversation with.
  #counts(): Pick<SessionInfo, 'activityCount' | 'proseCount'> {
    const base = this.config.counterBase
    const activity = this.#events.reduce((sum, event) => sum + transcriptActivity(event), 0)
    const prose = this.#events.reduce((sum, event) => sum + transcriptProse(event), 0)
    if (base === undefined && activity === 0 && prose === 0) {
      return {}
    }
    return { activityCount: activity + (base?.activity ?? 0), proseCount: prose + (base?.prose ?? 0) }
  }

  say(text: string): void {
    this.#emit({ type: 'assistant_message', uuid: `say-${this.#seq + 1}`, message: { role: 'assistant', content: [{ type: 'text', text }] } } as SessionEventBody)
  }

  subscribe(listener: (event: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) {
        listener(event)
      }
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  sendMessage(text: string): void {
    this.sent.push(text)
    if (this.#sdkSessionId === undefined && this.#status !== 'starting') {
      this.#name()
    }
  }
  setTitle(): void {}
  resolvePermission(): boolean {
    return false
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  busy(): void {
    this.#status = 'running'
    this.#emit({ type: 'status_changed', status: 'running' })
  }

  settle(): void {
    this.#status = 'idle'
    this.#emit({ type: 'status_changed', status: 'idle' })
  }

  emit(body: SessionEventBody): void {
    this.#emit(body)
  }

  close(): void {
    this.#status = 'closed'
    this.#emit({ type: 'session_closed', reason: 'server' })
  }

  #emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: Date.now() } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
}
