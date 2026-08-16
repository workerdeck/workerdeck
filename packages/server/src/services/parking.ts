import type {
  ParkedExecution,
  Runner,
  SessionRunnerConfig,
  ToolExecutionResult,
} from '@workerdeck/core'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import type { SessionRegistry } from './registry.ts'
import {
  isDormant,
  type DormantSessionRecord,
  type ParkedSessionRecord,
  type SessionStore,
  type StoredSessionRecord,
} from './session-store.ts'

export type SessionParkOptions = {
  registry: SessionRegistry
  store: SessionStore
  /**
   * Rebuild a stored session's runner. For a park the snapshot rides in on
   * `config.restore`, so the engine adopts the id, event log, and history; for a
   * dormant record there is no snapshot and the engine is asked to resume its
   * own session under the stored id. Either way the runner it returns must carry
   * `record.id` — {@link SessionParkManager} refuses one that does not.
   */
  rebuild: (record: StoredSessionRecord) => Promise<Runner>
  /** How many clients are attached to this session. A watched session stays live:
   * parking would pull the runner out from under the socket. */
  attachedCount: (sessionId: string) => number
  /** Wait this long after the last client detaches before parking, so a reconnect
   * (a wifi blip, a page reload) doesn't cost a teardown. Default 2000. */
  parkDelayMs?: number
  /** Grace given at {@link SessionParkManager.hydrate} to an execution whose
   * deadline passed while the server was down. Its result could not have been
   * delivered during the outage, so failing it the instant the process is back
   * would throw away an answer that is very likely seconds behind. Extends a
   * deadline, never shortens one. Default 60000. */
  expiredGraceMs?: number
  /** Veto + accounting hook, called before the teardown: the job queue frees the
   * run's concurrency slot here, and refuses (false) when the run is finalizing. */
  onParking?: (sessionId: string, executionId: string) => boolean
  /** The session is live again under a NEW runner object — anything holding the
   * old reference must rebind. */
  onResumed?: (sessionId: string, runner: Runner) => void
  /** Park/remember/resume failures. These are not session errors — the session
   * is intact, the host's storage or engine assembly isn't. */
  onError?: (
    error: unknown,
    context: { sessionId: string; phase: 'park' | 'remember' | 'resume' },
  ) => void
}

/**
 * Two ways a session outlives its runner, behind one door.
 *
 * **Parking** is deferred execution's other half: a session waiting on work no
 * process in this server is doing.
 *
 * **Dormancy** is the restart story for the engines that cannot park. Every live
 * claude or codex session leaves a small record naming its engine session id, so
 * a gateway that comes back up lists them and resumes one the first time someone
 * attaches. Both kinds live in the same store and come back through the same
 * `ensureLive`, which is why there is one class here and not two.
 *
 * The runner announces the moment with `status_changed: 'parked'` — emitted only
 * once every dispatch of the batch has been handed over, so the snapshot can never
 * miss a call that was still being dispatched. From there this class snapshots,
 * evicts, and persists; delivering a result rebuilds the runner under the same id
 * and hands the result to it. The session's identity, event log, and seq numbering
 * survive intact, so a client reattaching with `afterSeq` sees one unbroken stream.
 */
export class SessionParkManager {
  #options: SessionParkOptions
  /** executionId → sessionId, for routing a result to its session. Kept in memory
   * across the park; rebuilt from the store by {@link hydrate}. */
  #owners = new Map<string, string>()
  /** Executions already settled, kept until their session ends so a late or
   * duplicate delivery answers "already settled" instead of "never heard of it". */
  #settled = new Map<string, string>()
  #timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** One resume per session, ever: two results arriving together must not build
   * two runners under the same id (the second would orphan the first, leaking the
   * MCP connection the park existed to release). */
  #resuming = new Map<string, Promise<Runner | undefined>>()
  #detachTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The config each live session was built from — what a rebuild needs, and the
   * one thing a runner doesn't carry on its public surface. */
  #configs = new Map<string, SessionRunnerConfig>()
  /**
   * In-flight store work per session, so operations on one record run in order.
   *
   * Load-bearing with any store whose writes are real I/O. `#park` must evict the
   * runner *before* the save completes (an attach between `park()` and `evict()`
   * would bind a client to an inert runner), which leaves a window where the
   * session is in neither the registry nor the store. A delivery arriving inside it
   * would read past the write: `store.get` misses, the result is answered 404, the
   * execution is filed as settled with its watchdog cleared — and then the record
   * lands on disk with nothing left alive that could ever wake it. A `discard`
   * inside the same window would delete nothing and leave the save to resurrect a
   * session the caller was told was closed.
   */
  #storeOps = new Map<string, Promise<void>>()
  #closed = false

  constructor(options: SessionParkOptions) {
    this.#options = options
  }

  /** Record the config a session was created with. Only sessions the host
   * remembers can be parked — there is no way to rebuild the others. */
  remember(sessionId: string, config: SessionRunnerConfig): void {
    this.#configs.set(sessionId, config)
  }

  /**
   * Re-save a live session's dormant record because something outside the event
   * stream changed it.
   *
   * `#rememberDormant` is otherwise driven by `status_changed` and `system_init`
   * alone, and a rename (`PATCH /sessions/:id`) fires neither — so without this
   * a renamed session that is never touched again keeps its old title on disk
   * and comes back under it. Safe to call for anything: every gate in
   * `#rememberDormant` still applies, so a session that cannot be resumed, has
   * no engine session yet, or is no longer the registry's writes nothing.
   */
  touch(runner: Runner): void {
    void this.#rememberDormant(runner)
  }

  /**
   * Adopt the store's contents (a durable store after a restart): re-index the
   * executions and re-arm their watchdogs, no deadline sooner than the grace
   * window — nothing could have been delivered while the process was down.
   *
   * Dormant records need nothing here, which is the point of them. They list
   * from the store (`listInfo`) and come back on first attach (`ensureLive`), so
   * a boot with fifty remembered sessions spawns nothing at all.
   */
  async hydrate(): Promise<void> {
    const floor = Date.now() + (this.#options.expiredGraceMs ?? 60_000)
    for (const record of await this.#options.store.list()) {
      if (isDormant(record)) continue
      for (const execution of record.executions) this.#track(record.id, execution, floor)
    }
  }

  /**
   * Follow a session's lifecycle: index its deferred executions, park it when the
   * engine says the turn has come to rest on them, and clean up when it ends.
   * `afterSeq` skips a rehydrated runner's replayed history (re-arming a watchdog
   * from an event whose deadline already passed would fail the execution instantly).
   */
  watch(runner: Runner, afterSeq = 0): () => void {
    return runner.subscribe((event) => {
      switch (event.type) {
        case 'execution_dispatched':
          if (!event.deferred) return
          this.#track(runner.id, {
            executionId: event.executionId,
            toolName: event.toolName,
            expiresAt: event.expiresAt,
          })
          return
        case 'execution_result':
        case 'execution_failed':
          this.#forget(event.executionId)
          // One call of a multi-call park settling leaves the session parked on
          // the rest — it has to go back down, and no new status_changed will say so.
          if (runner.info().status === 'parked') void this.#park(runner)
          return
        case 'status_changed':
          if (event.status === 'parked') void this.#park(runner)
          else void this.#rememberDormant(runner)
          return
        case 'system_init':
          // The first moment a resume is even possible: before the engine names
          // its session there is nothing to come back to.
          void this.#rememberDormant(runner)
          return
        case 'session_closed':
          // Not during shutdown. The registry closes every runner on the way
          // down and the reason it gives is the same 'server' a DELETE produces,
          // so the *only* thing separating "this session is over" from "this
          // process is over" is that `close()` ran first — which is exactly why
          // it does (`server.ts` closes parking before the registry). Without
          // this guard a graceful restart forgets every dormant session it was
          // supposed to preserve.
          if (this.#closed) return
          void this.discard(runner.id)
          return
        default:
          return
      }
    }, afterSeq)
  }

  /** A client detached: park the session if that was the last one watching. */
  onDetach(sessionId: string): void {
    if (this.#closed) return
    const runner = this.#options.registry.get(sessionId)
    if (!runner || runner.info().status !== 'parked') return
    clearTimeout(this.#detachTimers.get(sessionId))
    const timer = setTimeout(() => {
      this.#detachTimers.delete(sessionId)
      void this.#park(runner)
    }, this.#options.parkDelayMs ?? 2000)
    timer.unref?.()
    this.#detachTimers.set(sessionId, timer)
  }

  /** Which session this execution belongs to — still waiting, or already settled. */
  sessionFor(executionId: string): string | undefined {
    return this.#owners.get(executionId) ?? this.#settled.get(executionId)
  }

  /** The stored session's record, for the read paths (GET, list, attach). */
  get(id: string): Promise<StoredSessionRecord | null> {
    return this.#queue(id, () => this.#options.store.get(id))
  }

  /** Every stored session's info, to merge into `GET {basePath}/sessions`. */
  async listInfo(): Promise<SessionInfo[]> {
    // A park mid-save belongs in the listing: it is neither in the registry nor
    // readable yet, and a caller that saw it there a moment ago must not see it
    // vanish. Waiting on the writes in flight is what keeps the two views joined.
    await Promise.all(this.#storeOps.values())
    const records = await this.#options.store.list()
    // A live session has a dormant record too — that is what makes it survive a
    // restart — so the registry wins and the record is skipped. Without this the
    // merged listing would show every running session twice.
    return records
      .filter((record) => this.#options.registry.get(record.id) === undefined)
      .map((record) => record.info)
  }

  /** The live runner for a session, rehydrating a parked one on demand. Undefined
   * when the session is neither live nor parked. */
  async ensureLive(id: string): Promise<Runner | undefined> {
    const live = this.#options.registry.get(id)
    if (live) return live
    return this.#resume(id)
  }

  /**
   * Deliver a deferred execution's result. Rehydrates the session if needed and
   * folds the result into its agent loop.
   *
   * Undefined = no session is waiting on that id. `applied: false` = it was already
   * settled: a duplicate delivery, or one racing the watchdog. Both are expected,
   * neither is an error.
   */
  async submitResult(
    executionId: string,
    result: ToolExecutionResult,
  ): Promise<{ applied: boolean; sessionId: string } | undefined> {
    const sessionId = this.#owners.get(executionId)
    if (sessionId === undefined) {
      // Already answered — by an earlier delivery, or by the watchdog it raced.
      // Waking the session to be told again would be worse than useless.
      const settled = this.#settled.get(executionId)
      return settled === undefined ? undefined : { applied: false, sessionId: settled }
    }
    const runner = await this.ensureLive(sessionId)
    if (!runner) {
      this.#forget(executionId)
      return undefined
    }
    // Clear the watchdog first: settling re-enters the agent loop, and a timeout
    // firing behind it would try to fail a call that no longer exists.
    this.#clearTimer(executionId)
    const applied = runner.settleExecution?.(executionId, result) ?? false
    if (applied) this.#forget(executionId)
    return { applied, sessionId }
  }

  /** Drop a parked session for good: the run is over (closed, canceled, killed). */
  async discard(sessionId: string): Promise<void> {
    clearTimeout(this.#detachTimers.get(sessionId))
    this.#detachTimers.delete(sessionId)
    this.#configs.delete(sessionId)
    for (const [executionId, owner] of this.#owners) {
      if (owner === sessionId) this.#forget(executionId)
    }
    for (const [executionId, owner] of this.#settled) {
      if (owner === sessionId) this.#settled.delete(executionId)
    }
    await this.#queue(sessionId, () => this.#options.store.delete(sessionId))
  }

  close(): void {
    this.#closed = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    for (const timer of this.#detachTimers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#detachTimers.clear()
  }

  /**
   * Write (or refresh) the dormant record that lets this session survive a
   * restart. Cheap and repeated on purpose — driven off `system_init` and every
   * non-park status change — because the alternative is a shutdown hook, and a
   * shutdown hook is exactly what a `kill -9`, an OOM or a pulled power cable
   * do not run.
   *
   * Four gates, each of which would otherwise produce a record that is worse
   * than none: the engine must be able to resume at all (a provider session
   * would come back with an empty transcript — it has `park()` instead), it must
   * have named its session, the host must remember the config to rebuild from,
   * and the runner must still be the registry's. That last one is what keeps a
   * park from being overwritten: `#park` evicts before it saves, so a late event
   * from an evicted runner finds itself a stranger here and writes nothing.
   */
  async #rememberDormant(runner: Runner): Promise<void> {
    if (this.#closed) return
    const info = runner.info()
    const sdkSessionId = info.sdkSessionId
    if (sdkSessionId === undefined) return
    const capabilities = info.capabilities ?? ENGINE_CAPABILITIES[info.engine ?? 'claude']
    if (!capabilities.resume) return
    const config = this.#configs.get(runner.id)
    if (!config) return
    if (this.#options.registry.get(runner.id) !== runner) return
    const record: DormantSessionRecord = {
      kind: 'dormant',
      id: runner.id,
      // Whatever it was doing, it is not doing it now: a record that came back
      // saying `running` would show a spinner over a session with no process.
      info: { ...info, status: 'idle' },
      profile: info.profile,
      // `#configs` holds the config the session was BUILT from, and a rename
      // never reaches it: `setTitle` replaces the runner's own `#config`. Since
      // a wake rebuilds from `record.config` and discards `record.info`, taking
      // the config's `meta` verbatim resurrected the pre-rename title — the
      // rename survived the listing (which reads `info`) and died on the wake.
      // `info.meta` IS the runner's live `#config.meta`, so this is the current
      // one by construction, not a copy that can drift.
      config: { ...config, meta: info.meta },
      sdkSessionId,
      savedAt: Date.now(),
    }
    try {
      await this.#queue(runner.id, () => this.#options.store.save(record))
    } catch (error) {
      // Losing this costs the session its way back after a restart, and nothing
      // else — the live session is untouched.
      this.#options.onError?.(error, { sessionId: runner.id, phase: 'remember' })
    }
  }

  async #park(runner: Runner): Promise<void> {
    if (this.#closed || !runner.park) return
    const id = runner.id
    if (this.#options.registry.get(id) !== runner) return
    if (runner.info().status !== 'parked') return
    // Someone is watching: keep it live and reconsider when they leave.
    if (this.#options.attachedCount(id) > 0) return
    const executions = [...this.#owners].filter(([, owner]) => owner === id).map(([e]) => e)
    if (executions.length === 0) return
    const config = this.#configs.get(id)
    if (!config) return
    if (this.#options.onParking && !this.#options.onParking(id, executions[0]!)) return
    // park() → evict in one tick: an attach landing between them would bind a
    // client to a runner that is already inert.
    const snapshot = runner.park()
    if (!snapshot) return
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
    for (const execution of snapshot.parked) this.#track(id, execution)
    try {
      await this.#queue(id, () => this.#options.store.save(record))
    } catch (error) {
      // The runner is already inert and evicted; without the record the session
      // cannot come back. Nothing to roll back to — surface it loudly.
      this.#options.onError?.(error, { sessionId: id, phase: 'park' })
    }
  }

  async #resume(id: string): Promise<Runner | undefined> {
    const inFlight = this.#resuming.get(id)
    if (inFlight) return inFlight
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
    if (!record) return undefined
    let runner: Runner
    try {
      runner = await this.#options.rebuild(record)
    } catch (error) {
      // Keep the record: the failure may be transient (an MCP server down), and
      // the next delivery — or a retried one — gets another chance.
      this.#options.onError?.(error, { sessionId: id, phase: 'resume' })
      throw error
    }
    if (runner.id !== id) {
      // The factory ignored `restore` (or, for a dormant record, the id): it
      // built a fresh session with none of this one's history, which would
      // strand the execution we are waking for and orphan every client's
      // watermarks against an id that no longer exists.
      runner.close('error')
      const error = new Error(
        `rebuilt session has id '${runner.id}', expected '${id}' — the engine factory must ` +
          'forward EngineRunnerContext.restore (or, without a snapshot, the session id) ' +
          'to the runner config',
      )
      this.#options.onError?.(error, { sessionId: id, phase: 'resume' })
      throw error
    }
    // Registered and subscribed before it starts, so nothing it emits on the way
    // back up is missed by the queue or the watchers.
    this.#options.registry.register(runner)
    this.remember(id, record.config)
    // A park resumes mid-stream and must not re-arm watchdogs from its own
    // replayed events; a dormant session starts a fresh event log (the history
    // arrives as the engine's `replay: true` backfill), so there is no prior seq
    // to skip and nothing deferred in it to re-index.
    this.watch(runner, isDormant(record) ? 0 : record.snapshot.seq)
    this.#options.onResumed?.(id, runner)
    // A park's record *is* the session — consumed on wake. A dormant one is a
    // way back that the session still needs the next time the process dies, so
    // it stays and is refreshed in place; `listInfo` already hides it while the
    // registry has the session, and `discard` removes it when the session ends.
    if (!isDormant(record)) await this.#queue(id, () => this.#options.store.delete(id))
    void runner.start()
    return runner
  }

  /** Run a store operation after whatever is already in flight for this session.
   * The chain is per session and drops itself once idle; a failed operation never
   * poisons the ones behind it (each caller handles its own). */
  #queue<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.#storeOps.get(sessionId) ?? Promise.resolve()
    const result = previous.then(op)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.#storeOps.set(sessionId, settled)
    void settled.then(() => {
      if (this.#storeOps.get(sessionId) === settled) this.#storeOps.delete(sessionId)
    })
    return result
  }

  #track(sessionId: string, execution: ParkedExecution, notBefore = 0): void {
    this.#owners.set(execution.executionId, sessionId)
    if (execution.expiresAt === undefined || this.#timers.has(execution.executionId)) return
    const expiresAt = Math.max(execution.expiresAt, notBefore)
    const timer = setTimeout(
      () => {
        this.#timers.delete(execution.executionId)
        // A result that never came is ordinary tool output, not a session error:
        // the agent gets told and adapts, exactly like a sandbox failure.
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
    if (owner !== undefined) this.#settled.set(executionId, owner)
    this.#owners.delete(executionId)
  }

  #clearTimer(executionId: string): void {
    const timer = this.#timers.get(executionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#timers.delete(executionId)
  }
}
