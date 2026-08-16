import type {
  ParkedExecution,
  Runner,
  RunnerSnapshot,
  SessionRunnerConfig,
  ToolExecutionResult,
} from '@workerdeck/core'
import type { SessionEvent, SessionEventBody, SessionInfo } from '@workerdeck/protocol'

/**
 * A runner that parks the way the provider engine does: it announces the park with
 * `status_changed: 'parked'` once its deferred executions are dispatched, hands
 * over a snapshot on `park()`, and comes back as a NEW object under the same id.
 *
 * Deliberately not the real `AiSdkRunner`: this package must never depend on a
 * model SDK. The engine's own park/restore semantics are covered in
 * `packages/core/test/park-restore.test.ts`; what is under test here is the
 * server's half — persist, evict, index, wake, and the routes around it.
 */
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
  /** Stands in for the provider engine's `ModelMessage[]`: the thing a park
   * preserves and a write-through has to carry across a restart. */
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
      for (const execution of restore.parked) this.#pending.set(execution.executionId, execution)
      // Derived, exactly as the real runner derives it: a snapshot with nothing
      // pending is an *idle* session that was written through, not a parked one.
      // Hardcoding 'parked' here would have every restored live session come
      // back claiming to wait on work it does not have.
      this.#status = this.#pending.size > 0 ? 'parked' : 'idle'
    }
  }

  /** Dispatch a deferred execution and come to rest on it, like a parked turn. */
  defer(executionId: string, toolName = 'remote_task', expiresAt?: number): void {
    this.#pending.set(executionId, { executionId, toolName, expiresAt })
    this.#emit({ type: 'execution_dispatched', executionId, toolName, backend: 'remote', deferred: true, expiresAt })
    this.#status = 'parked'
    this.#emit({ type: 'status_changed', status: 'parked' })
  }

  park(): RunnerSnapshot | undefined {
    if (this.#parked || this.#pending.size === 0) return undefined
    this.#parked = true
    this.#listeners.clear()
    return this.#buildSnapshot()
  }

  /** The non-destructive half, mirroring the real runner: same value, nothing
   * torn down, and allowed at rest with nothing pending — which is exactly the
   * case `park()` above refuses. */
  snapshot(): RunnerSnapshot | undefined {
    if (this.#parked) return undefined
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

  /** What the session has said and been told — the history a restart must keep. */
  get messages(): string[] {
    return [...this.#messages]
  }

  /** Write to the scratch filesystem, so a round-trip has something to prove. */
  writeFile(path: string, content: string): void {
    this.#files[path] = content
  }

  settleExecution(executionId: string, result: ToolExecutionResult): boolean {
    if (this.#parked || !this.#pending.has(executionId)) return false
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

  /** Take a turn, the way a live conversation does: the prompt and the answer
   * both land in the history, and the turn ends. */
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

  /** Switch the model — one of the write-through triggers, and the one that can
   * fire while the session is anything but idle. */
  changeModel(model: string): void {
    this.#emit({ type: 'model_changed', model })
  }

  /** Finish the run, the way a completed turn would. */
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
      // Echoed like every real runner — `buildRunner` asserts on it, and every
      // scope check downstream reads it.
      scope: this.#config.scope,
      // `info().meta` IS the live `#config.meta`, which is what `setTitle`
      // writes — the property both record kinds depend on to carry a rename
      // across a restart. Absent here, a rename looked correct in the listing
      // and died on the wake, which is exactly the bug it must not have.
      meta: this.#config.meta,
      title: typeof this.#config.meta?.title === 'string' ? this.#config.meta.title : undefined,
    }
  }
  subscribe(listener: (event: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.#events) if (event.seq > afterSeq) listener(event)
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
    if (this.#parked) return
    this.#emit({ type: 'session_closed', reason: 'server' })
  }

  #emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: Date.now() } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) listener(event)
  }
}
