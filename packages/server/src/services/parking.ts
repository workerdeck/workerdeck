import type { ParkedExecution, Runner, SessionRunnerConfig, ToolExecutionResult } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import type { SessionRegistry } from './registry.ts'
import {
  isDormant,
  isLiveRecord,
  type DormantSessionRecord,
  type ParkedSessionRecord,
  type SessionStore,
  type StoredSessionRecord,
} from './session-store.ts'

export type SessionParkOptions = {
  registry: SessionRegistry
  store: SessionStore
  rebuild: (record: StoredSessionRecord) => Promise<Runner>
  attachedCount: (sessionId: string) => number
  parkDelayMs?: number
  persistLive?: boolean
  expiredGraceMs?: number
  onParking?: (sessionId: string, executionId: string) => boolean
  onResumed?: (sessionId: string, runner: Runner) => void
  onError?: (error: unknown, context: { sessionId: string; phase: 'park' | 'remember' | 'resume' }) => void
}

export class SessionParkManager {
  #options: SessionParkOptions
  #owners = new Map<string, string>()
  #settled = new Map<string, string>()
  #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #resuming = new Map<string, Promise<Runner | undefined>>()
  #detachTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #configs = new Map<string, SessionRunnerConfig>()
  #remembered = new Set<string>()
  #storeOps = new Map<string, Promise<void>>()
  #closed = false

  constructor(options: SessionParkOptions) {
    this.#options = options
  }

  remember(sessionId: string, config: SessionRunnerConfig): void {
    this.#configs.set(sessionId, config)
  }

  touch(runner: Runner): void {
    void this.#rememberDormant(runner)
    void this.#persistLive(runner)
  }

  async hydrate(): Promise<void> {
    const floor = Date.now() + (this.#options.expiredGraceMs ?? 60_000)
    for (const record of await this.#options.store.list()) {
      if (isDormant(record)) {
        continue
      }
      for (const execution of record.executions) {
        this.#track(record.id, execution, floor)
      }
    }
  }

  watch(runner: Runner, afterSeq = 0): () => void {
    return runner.subscribe((event) => {
      switch (event.type) {
        case 'execution_dispatched': {
          if (!event.deferred) {
            return
          }
          this.#track(runner.id, {
            executionId: event.executionId,
            toolName: event.toolName,
            expiresAt: event.expiresAt,
          })
          return
        }
        case 'execution_result':
        case 'execution_failed': {
          this.#forget(event.executionId)
          // One call of a multi-call park settling leaves the session parked on the rest, and no new status_changed will say so.
          if (runner.info().status === 'parked') {
            void this.#park(runner)
          }
          return
        }
        case 'status_changed': {
          if (event.status === 'parked') {
            void this.#park(runner)
          } else {
            void this.#rememberDormant(runner)
          }
          return
        }
        case 'turn_result': {
          void this.#persistLive(runner)
          return
        }
        case 'permission_mode_changed':
        case 'model_changed': {
          void this.#persistLive(runner)
          return
        }
        case 'system_init': {
          void this.#rememberDormant(runner)
          return
        }
        case 'conversation_reset': {
          void this.#rememberDormant(runner)
          void this.#persistLive(runner)
          return
        }
        case 'session_closed': {
          if (this.#closed) {
            return
          }
          void this.discard(runner.id)
          return
        }
        default: {
          return
        }
      }
    }, afterSeq)
  }

  onDetach(sessionId: string): void {
    if (this.#closed) {
      return
    }
    const runner = this.#options.registry.get(sessionId)
    if (!runner || runner.info().status !== 'parked') {
      return
    }
    clearTimeout(this.#detachTimers.get(sessionId))
    const timer = setTimeout(() => {
      this.#detachTimers.delete(sessionId)
      void this.#park(runner)
    }, this.#options.parkDelayMs ?? 2000)
    timer.unref?.()
    this.#detachTimers.set(sessionId, timer)
  }

  sessionFor(executionId: string): string | undefined {
    return this.#owners.get(executionId) ?? this.#settled.get(executionId)
  }

  get(id: string): Promise<StoredSessionRecord | null> {
    return this.#queue(id, () => this.#options.store.get(id))
  }

  async listInfo(): Promise<SessionInfo[]> {
    await Promise.all(this.#storeOps.values())
    const records = await this.#options.store.list()
    return records.filter((record) => this.#options.registry.get(record.id) === undefined).map((record) => record.info)
  }

  async ensureLive(id: string): Promise<Runner | undefined> {
    const live = this.#options.registry.get(id)
    if (live) {
      return live
    }
    return this.#resume(id)
  }

  async submitResult(executionId: string, result: ToolExecutionResult): Promise<{ applied: boolean; sessionId: string } | undefined> {
    const sessionId = this.#owners.get(executionId)
    if (sessionId === undefined) {
      const settled = this.#settled.get(executionId)
      return settled === undefined ? undefined : { applied: false, sessionId: settled }
    }
    const runner = await this.ensureLive(sessionId)
    if (!runner) {
      this.#forget(executionId)
      return undefined
    }
    // Clear the watchdog first: settling re-enters the agent loop, and a timeout firing behind it would fail a call that no longer exists.
    this.#clearTimer(executionId)
    const applied = runner.settleExecution?.(executionId, result) ?? false
    if (applied) {
      this.#forget(executionId)
    }
    return { applied, sessionId }
  }

  async discard(sessionId: string): Promise<void> {
    clearTimeout(this.#detachTimers.get(sessionId))
    this.#detachTimers.delete(sessionId)
    this.#configs.delete(sessionId)
    this.#remembered.delete(sessionId)
    for (const [executionId, owner] of this.#owners) {
      if (owner === sessionId) {
        this.#forget(executionId)
      }
    }
    for (const [executionId, owner] of this.#settled) {
      if (owner === sessionId) {
        this.#settled.delete(executionId)
      }
    }
    await this.#queue(sessionId, () => this.#options.store.delete(sessionId))
  }

  close(): void {
    this.#closed = true
    for (const timer of this.#timers.values()) {
      clearTimeout(timer)
    }
    for (const timer of this.#detachTimers.values()) {
      clearTimeout(timer)
    }
    this.#timers.clear()
    this.#detachTimers.clear()
  }

  async #rememberDormant(runner: Runner): Promise<void> {
    if (this.#closed) {
      return
    }
    const info = runner.info()
    const capabilities = info.capabilities ?? ENGINE_CAPABILITIES[info.engine ?? 'claude']
    if (!capabilities.resume) {
      return
    }
    const config = this.#configs.get(runner.id)
    if (!config) {
      return
    }
    if (this.#options.registry.get(runner.id) !== runner) {
      return
    }
    const sdkSessionId = info.sdkSessionId
    if (sdkSessionId === undefined) {
      // Checked last, behind the ownership guard: before the engine has ever named a session there is no record to remove.
      if (this.#remembered.has(runner.id)) {
        await this.#forgetDormant(runner.id)
      }
      return
    }
    const record: DormantSessionRecord = {
      kind: 'dormant',
      id: runner.id,
      info: { ...info, status: 'idle' },
      profile: info.profile,
      config: { ...config, meta: info.meta },
      sdkSessionId,
      savedAt: Date.now(),
    }
    try {
      // Marked before the write: a queued save already means a record may exist, and a reset arriving mid-write must not skip the forget.
      this.#remembered.add(runner.id)
      await this.#queue(runner.id, () => this.#options.store.save(record))
    } catch (error) {
      this.#options.onError?.(error, { sessionId: runner.id, phase: 'remember' })
    }
  }

  async #forgetDormant(sessionId: string): Promise<void> {
    this.#remembered.delete(sessionId)
    try {
      await this.#queue(sessionId, () => this.#options.store.delete(sessionId))
    } catch (error) {
      this.#options.onError?.(error, { sessionId, phase: 'remember' })
    }
  }

  async #persistLive(runner: Runner): Promise<void> {
    if (this.#closed || !this.#options.persistLive || !runner.snapshot) {
      return
    }
    const config = this.#configs.get(runner.id)
    if (!config) {
      return
    }
    if (this.#options.registry.get(runner.id) !== runner) {
      return
    }
    try {
      await this.#queue(runner.id, async () => {
        // Re-checked inside the queue: a park's record must not be overwritten by the live copy queued behind it.
        if (this.#closed || this.#options.registry.get(runner.id) !== runner) {
          return
        }
        const snapshot = runner.snapshot?.()
        if (!snapshot) {
          return
        }
        const info = runner.info()
        const record: ParkedSessionRecord = {
          kind: 'live',
          id: runner.id,
          info: { ...info, status: 'idle' },
          profile: info.profile,
          config: { ...config, meta: info.meta },
          snapshot,
          executions: snapshot.parked,
          parkedAt: Date.now(),
        }
        await this.#options.store.save(record)
      })
    } catch (error) {
      this.#options.onError?.(error, { sessionId: runner.id, phase: 'remember' })
    }
  }

  async #park(runner: Runner): Promise<void> {
    if (this.#closed || !runner.park) {
      return
    }
    const id = runner.id
    if (this.#options.registry.get(id) !== runner) {
      return
    }
    if (runner.info().status !== 'parked') {
      return
    }
    if (this.#options.attachedCount(id) > 0) {
      return
    }
    const executions = [...this.#owners].filter(([, owner]) => owner === id).map(([e]) => e)
    if (executions.length === 0) {
      return
    }
    const config = this.#configs.get(id)
    if (!config) {
      return
    }
    if (this.#options.onParking && !this.#options.onParking(id, executions[0]!)) {
      return
    }
    const snapshot = runner.park()
    if (!snapshot) {
      return
    }
    const info = { ...runner.info(), status: 'parked' as const }
    this.#options.registry.evict(id)
    const record: ParkedSessionRecord = {
      kind: 'parked',
      id,
      info,
      profile: info.profile,
      config,
      snapshot,
      executions: snapshot.parked,
      parkedAt: Date.now(),
    }
    for (const execution of snapshot.parked) {
      this.#track(id, execution)
    }
    try {
      await this.#queue(id, () => this.#options.store.save(record))
    } catch (error) {
      this.#options.onError?.(error, { sessionId: id, phase: 'park' })
    }
  }

  async #resume(id: string): Promise<Runner | undefined> {
    const inFlight = this.#resuming.get(id)
    if (inFlight) {
      return inFlight
    }
    const attempt = this.#rebuild(id)
    this.#resuming.set(id, attempt)
    try {
      return await attempt
    } finally {
      this.#resuming.delete(id)
    }
  }

  async #rebuild(id: string): Promise<Runner | undefined> {
    const record = await this.#queue(id, () => this.#options.store.get(id))
    if (!record) {
      return undefined
    }
    let runner: Runner
    try {
      runner = await this.#options.rebuild(record)
    } catch (error) {
      this.#options.onError?.(error, { sessionId: id, phase: 'resume' })
      throw error
    }
    if (runner.id !== id) {
      runner.close('error')
      const error = new Error(
        `rebuilt session has id '${runner.id}', expected '${id}' — the engine factory must ` +
          'forward EngineRunnerContext.restore (or, without a snapshot, the session id) ' +
          'to the runner config',
      )
      this.#options.onError?.(error, { sessionId: id, phase: 'resume' })
      throw error
    }
    this.#options.registry.register(runner)
    this.remember(id, record.config)
    // A park must not re-arm watchdogs from its own replayed events; a dormant session starts a fresh log, so it has no prior seq to skip.
    this.watch(runner, isDormant(record) ? 0 : record.snapshot.seq)
    this.#options.onResumed?.(id, runner)
    if (!isDormant(record) && !isLiveRecord(record)) {
      await this.#queue(id, () => this.#options.store.delete(id))
    }
    void runner.start()
    return runner
  }

  #queue<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.#storeOps.get(sessionId) ?? Promise.resolve()
    const result = previous.then(op)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.#storeOps.set(sessionId, settled)
    void settled.then(() => {
      if (this.#storeOps.get(sessionId) === settled) {
        this.#storeOps.delete(sessionId)
      }
    })
    return result
  }

  #track(sessionId: string, execution: ParkedExecution, notBefore = 0): void {
    this.#owners.set(execution.executionId, sessionId)
    if (execution.expiresAt === undefined || this.#timers.has(execution.executionId)) {
      return
    }
    const expiresAt = Math.max(execution.expiresAt, notBefore)
    const timer = setTimeout(
      () => {
        this.#timers.delete(execution.executionId)
        void this.submitResult(execution.executionId, {
          status: 'failed',
          reason: 'timeout',
          error: `deferred execution '${execution.toolName}' produced no result before its deadline`,
        }).catch((error: unknown) => {
          this.#options.onError?.(error, { sessionId, phase: 'resume' })
        })
      },
      Math.max(0, expiresAt - Date.now()),
    )
    timer.unref?.()
    this.#timers.set(execution.executionId, timer)
  }

  #forget(executionId: string): void {
    this.#clearTimer(executionId)
    const owner = this.#owners.get(executionId)
    if (owner !== undefined) {
      this.#settled.set(executionId, owner)
    }
    this.#owners.delete(executionId)
  }

  #clearTimer(executionId: string): void {
    const timer = this.#timers.get(executionId)
    if (timer === undefined) {
      return
    }
    clearTimeout(timer)
    this.#timers.delete(executionId)
  }
}
