import type { ParkedExecution, Runner, SessionRunnerConfig, ToolExecutionResult } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import { engineOf } from '../lib/profile-env.ts'
import type { SessionRegistry } from './registry.ts'
import {
  isDormant,
  isLiveRecord,
  type DormantSessionRecord,
  type ParkedSessionRecord,
  type SessionStore,
  type StoredSessionRecord,
} from './session-store.ts'

// The context handed to parking's onError: which session, and which lifecycle step failed.
export type ParkErrorContext = { sessionId: string; phase: 'park' | 'remember' | 'resume' | 'discard' }

const SETTLED_MAX = 4096

export type SessionParkOptions = {
  registry: SessionRegistry
  store: SessionStore
  rebuild: (record: StoredSessionRecord) => Promise<Runner>
  attachedCount: (sessionId: string) => number
  parkDelayMs?: number
  persistLive?: boolean
  expiredGraceMs?: number
  onParking?: (sessionId: string, executionId: string) => boolean
  onParked?: (sessionId: string, executionId: string) => void
  onResumed?: (sessionId: string, runner: Runner) => void
  onError?: (error: unknown, context: ParkErrorContext) => void
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
  #watches = new Map<string, () => void>()
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

  // The unsubscribe is retained, not merely returned. Every caller drops it, and `#track` has neither the `#closed`
  // guard the writers have nor an ownership check: a deferred dispatch reaching a closed manager still arms a
  // watchdog, and when that fires it rebuilds the session through the registry and factory of a generation that is
  // over. `release()` is the only thing that can take the listener off a runner nobody closed.
  watch(runner: Runner, afterSeq = 0): () => void {
    this.#watches.get(runner.id)?.()
    const unsubscribe = runner.subscribe((event) => {
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
            this.#parkQuietly(runner)
          }
          return
        }
        case 'status_changed': {
          if (event.status === 'parked') {
            this.#parkQuietly(runner)
          } else {
            void this.#rememberDormant(runner)
          }
          return
        }
        case 'turn_result':
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
          this.discard(runner.id).catch((error: unknown) => this.#options.onError?.(error, { sessionId: runner.id, phase: 'discard' }))
          return
        }
        default: {
          return
        }
      }
    }, afterSeq)
    const detach = (): void => {
      if (this.#watches.get(runner.id) === detach) {
        this.#watches.delete(runner.id)
      }
      unsubscribe()
    }
    this.#watches.set(runner.id, detach)
    return detach
  }

  // Hands a live session to another manager: stops watching it, forgets what this manager knows about it, and
  // returns the one fact the next manager cannot rederive. A durable record strips `env`, `queryFn`, `historyFn`
  // and `extraOptions`, and before `system_init` there is no record at all, so `#configs` is not recoverable from
  // the store. Deliberately leaves the store alone: the record is the point of the handover, not a casualty of it.
  release(sessionId: string): SessionRunnerConfig | undefined {
    this.#watches.get(sessionId)?.()
    const config = this.#configs.get(sessionId)
    this.#forgetSession(sessionId)
    return config
  }

  // The order is what `#rememberDormant`'s ownership guard turns into a silent no-write if reversed: `touch()`
  // writes nothing for a runner this manager's registry does not hold, so the register comes first. `#rebuild` does
  // the same four steps for the same reason. `lastSeq`, never 0: replaying a long session's history queues one
  // dormant re-save per historical `status_changed`, and the single `touch()` is what writes the current record.
  adopt(runner: Runner, config?: SessionRunnerConfig): void {
    this.#options.registry.register(runner)
    if (config) {
      this.remember(runner.id, config)
    }
    this.watch(runner, runner.info().lastSeq)
    this.touch(runner)
  }

  // `touch()` is fire-and-forget for the PATCH route that has no one to report to. A caller that is about to close
  // this manager, or to let another one write the same files, needs to know the write landed.
  async flush(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      await Promise.all(this.#storeOps.values())
      return
    }
    await this.#storeOps.get(sessionId)
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
      this.#parkQuietly(runner)
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

  // Renamed in place: waking an engine child to change a label is the wrong trade. Undefined once the session is live.
  retitle(id: string, title: string | undefined): Promise<SessionInfo | undefined> {
    return this.#queue(id, async () => {
      const record = await this.#options.store.get(id)
      if (!record || this.#options.registry.get(id)) {
        return undefined
      }
      const { title: previous, ...meta } = record.config.meta ?? {}
      const shown = title ?? (record.info.title === previous ? undefined : record.info.title)
      const info: SessionInfo = { ...record.info, title: shown, meta: title ? { ...record.info.meta, title } : meta }
      const config: SessionRunnerConfig = { ...record.config, meta: title ? { ...meta, title } : meta }
      await this.#options.store.save({ ...record, info, config })
      return info
    })
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
    // Dropped rather than run: `discard` is reached from the `session_closed` arm of the very subscription this
    // handle unsubscribes, and the runner drops its subscribers on close anyway.
    this.#forgetSession(sessionId)
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

  #forgetSession(sessionId: string): void {
    this.#watches.delete(sessionId)
    clearTimeout(this.#detachTimers.get(sessionId))
    this.#detachTimers.delete(sessionId)
    this.#configs.delete(sessionId)
    this.#remembered.delete(sessionId)
  }

  // The config of a runner this manager may still write for: open, remembered, and the registry's current object.
  #ownedConfig(runner: Runner): SessionRunnerConfig | undefined {
    if (this.#closed || this.#options.registry.get(runner.id) !== runner) {
      return undefined
    }
    return this.#configs.get(runner.id)
  }

  async #rememberDormant(runner: Runner): Promise<void> {
    const config = this.#ownedConfig(runner)
    const info = runner.info()
    if (!config || !(info.capabilities ?? ENGINE_CAPABILITIES[engineOf(info)]).resume) {
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
    const record: DormantSessionRecord = { kind: 'dormant', ...idleRecordBase(runner, config), sdkSessionId, savedAt: Date.now() }
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
    const config = this.#ownedConfig(runner)
    if (!config || !this.#options.persistLive || !runner.snapshot) {
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
        const record: ParkedSessionRecord = {
          kind: 'live',
          ...idleRecordBase(runner, config),
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

  #parkQuietly(runner: Runner): void {
    this.#park(runner).catch((error: unknown) => this.#options.onError?.(error, { sessionId: runner.id, phase: 'park' }))
  }

  async #park(runner: Runner): Promise<void> {
    const config = this.#ownedConfig(runner)
    const id = runner.id
    if (!config || !runner.park || runner.info().status !== 'parked' || this.#options.attachedCount(id) > 0) {
      return
    }
    const executions = [...this.#owners].filter(([, owner]) => owner === id).map(([e]) => e)
    if (executions.length === 0) {
      return
    }
    if (this.#options.onParking && !this.#options.onParking(id, executions[0]!)) {
      return
    }
    const cost = runner.costState?.()
    const snapshot = runner.park()
    if (!snapshot) {
      return
    }
    this.#options.onParked?.(id, executions[0]!)
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
      cost,
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
        `rebuilt session has id '${runner.id}', expected '${id}' - the engine factory must ` +
          'forward EngineRunnerContext.restore (or, without a snapshot, the session id) ' +
          'to the runner config',
      )
      this.#options.onError?.(error, { sessionId: id, phase: 'resume' })
      throw error
    }
    runner.carryCost?.(record.cost ?? { byModel: record.info.usageByModel, reportedCostUsd: record.info.totalCostUsd })
    this.#options.registry.register(runner)
    // The config the runner was actually built with, not the one on the record: a dormant wake
    // bumps the epoch, and the next park must carry the new one rather than resurrect the old.
    this.remember(id, { ...record.config, epoch: runner.info().epoch })
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
      if (this.#settled.size > SETTLED_MAX) {
        this.#settled.delete(this.#settled.keys().next().value!)
      }
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

// What a dormant and a live record share: the session as it would list while nothing runs it, and the config it was
// built with plus the metadata it has gathered since.
function idleRecordBase(
  runner: Runner,
  config: SessionRunnerConfig,
): Pick<ParkedSessionRecord, 'id' | 'info' | 'profile' | 'config' | 'cost'> {
  const info = runner.info()
  return {
    id: runner.id,
    info: { ...info, status: 'idle' },
    profile: info.profile,
    config: { ...config, meta: info.meta },
    cost: runner.costState?.(),
  }
}
