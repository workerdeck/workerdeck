import type { ParkedExecution, Runner, RunnerSnapshot, SessionRunnerConfig, ToolExecutionResult } from '@workerdeck/core'
import type { SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'

// Parks the way the provider engine does, without the model SDK this package must never depend on.
export class ParkableRunner implements Runner {
  readonly id: string
  readonly createdAt = Date.now()
  readonly pendingApprovals = []
  settled: Array<{ executionId: string; result: ToolExecutionResult }> = []
  vfs: { list: () => string[]; read: (p: string) => string | undefined; write: () => void; snapshot: () => Record<string, string> }
  #config: SessionRunnerConfig
  #status: SessionInfo['status'] = 'idle'
  #events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0
  #pending = new Map<string, ParkedExecution>()
  #files: Record<string, string>
  #parked = false
  #messages: string[] = []

  constructor(id: string, config: SessionRunnerConfig, restore?: RunnerSnapshot) {
    this.id = id
    this.#config = config
    this.#files = restore?.vfs ?? { '/out/report.md': '# draft' }
    this.#messages = [...((restore?.state as { messages?: string[] })?.messages ?? [])]
    this.vfs = {
      list: () => Object.keys(this.#files).sort(),
      read: (path) => this.#files[path],
      write: () => {},
      snapshot: () => ({ ...this.#files }),
    }
    if (restore) {
      this.#seq = restore.seq
      this.#events = [...restore.events]
      for (const execution of restore.parked) {
        this.#pending.set(execution.executionId, execution)
      }
      // Derived as the real runner derives it: a snapshot with nothing pending is an idle write-through, not a park.
      this.#status = this.#pending.size > 0 ? 'parked' : 'idle'
    }
  }

  defer(executionId: string, toolName = 'remote_task', expiresAt?: number): void {
    this.#pending.set(executionId, { executionId, toolName, expiresAt })
    this.#emit({ type: 'execution_dispatched', executionId, toolName, backend: 'remote', deferred: true, expiresAt })
    this.#status = 'parked'
    this.#emit({ type: 'status_changed', status: 'parked' })
  }

  park(): RunnerSnapshot | undefined {
    if (this.#parked || this.#pending.size === 0) {
      return undefined
    }
    this.#parked = true
    this.#listeners.clear()
    return this.#buildSnapshot()
  }

  snapshot(): RunnerSnapshot | undefined {
    if (this.#parked) {
      return undefined
    }
    return this.#buildSnapshot()
  }

  #buildSnapshot(): RunnerSnapshot {
    return {
      engine: 'provider',
      id: this.id,
      createdAt: this.createdAt,
      seq: this.#seq,
      events: [...this.#events],
      vfs: { ...this.#files },
      parked: [...this.#pending.values()],
      state: { messages: [...this.#messages] },
    }
  }

  get messages(): string[] {
    return [...this.#messages]
  }

  writeFile(path: string, content: string): void {
    this.#files[path] = content
  }

  settleExecution(executionId: string, result: ToolExecutionResult): boolean {
    if (this.#parked || !this.#pending.has(executionId)) {
      return false
    }
    this.#pending.delete(executionId)
    this.settled.push({ executionId, result })
    this.#emit(
      result.status === 'ok'
        ? { type: 'execution_result', executionId, output: { type: 'json', value: result.output } }
        : { type: 'execution_failed', executionId, reason: result.reason, error: result.error },
    )
    if (this.#pending.size === 0) {
      this.#status = 'running'
      this.#emit({ type: 'status_changed', status: 'running' })
    }
    return true
  }

  turn(prompt: string, answer: string): void {
    this.#status = 'running'
    this.#emit({ type: 'status_changed', status: 'running' })
    this.#messages.push(`user:${prompt}`)
    this.#emit({ type: 'user_message', message: { role: 'user', content: prompt }, parentToolUseId: null })
    this.#messages.push(`assistant:${answer}`)
    this.#emit({
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }], model: 'test-model' },
      parentToolUseId: null,
      uuid: `a${this.#seq}`,
    })
    this.finish()
    this.#emit({ type: 'status_changed', status: 'idle' })
  }

  toolResult(toolUseId: string, content: string, name = 'Bash'): void {
    this.#emit({
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name, input: {} }],
        model: 'test-model',
      },
      parentToolUseId: null,
      uuid: `t${this.#seq}`,
    })
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
      parentToolUseId: null,
    })
  }

  changeModel(model: string): void {
    this.#emit({ type: 'model_changed', model })
  }

  finish(): void {
    this.#status = 'idle'
    this.#emit({
      type: 'turn_result',
      subtype: 'success',
      isError: false,
      durationMs: 5,
      numTurns: 1,
      totalCostUsd: 0,
      result: 'done',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  async start(): Promise<void> {}
  info(): SessionInfo {
    return {
      id: this.id,
      status: this.#status,
      cwd: this.#config.cwd ?? '',
      profile: this.#config.profile,
      engine: 'provider',
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      scope: this.#config.scope,
      meta: this.#config.meta,
      title: typeof this.#config.meta?.title === 'string' ? this.#config.meta.title : undefined,
    }
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
  sendMessage(): void {}
  setTitle(title: string | undefined): void {
    this.#config = { ...this.#config, meta: { ...this.#config.meta, title } }
  }
  resolvePermission(): boolean {
    return false
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  close(): void {
    if (this.#parked) {
      return
    }
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
