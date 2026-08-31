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
  /**
   * Keep a live session's snapshot written through to the store — the restart story for the
   * provider engine, which has no engine-side session to go dormant against. **Off by default**:
   * a library must not start writing a session's whole transcript to disk because someone
   * upgraded. Written at turn end, never on a shutdown hook, because a `kill -9` runs no hook.
   */
  persistLive?: boolean
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
  onError?: (error: unknown, context: { sessionId: string; phase: 'park' | 'remember' | 'resume' }) => void
}

/**
 * Two ways a session outlives its runner, behind one door: **parking** (deferred execution's
 * other half) and **dormancy** (the restart story for the engines that cannot park). Both live in
 * the same store and come back through the same `ensureLive`, which is why this is one class.
 *
 * Whichever path, the session's identity, event log and seq numbering survive intact, so a client
 * reattaching with `afterSeq` sees one unbroken stream. See `docs/GOTCHAS.md` §Parking & bridged
 * execution for the rules this must not break.
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
   * Sessions this process has written a dormant record for. Its only job is to
   * tell "the engine has not named its session *yet*" apart from "the engine
   * had named it and no longer has one" (a `conversation_reset` on an engine
   * whose fresh id is not known until its next turn) — the first is the normal
   * startup window and must cost no store write, the second must delete a
   * record that has gone stale. It is accurate for exactly the sessions that
   * matter: a woken session's runner is rebuilt with `resume` set, so it names
   * its engine session immediately and re-enters the set on its first save.
   */
  #remembered = new Set<string>()
  /**
   * In-flight store work per session, so operations on one record run in order — load-bearing
   * with any store whose writes are real I/O, because `#park` must evict the runner *before* the
   * save completes and a read that slips into that window sees the session in neither the
   * registry nor the store. See `docs/GOTCHAS.md` §Parking & bridged execution.
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
    // Both, because a session has exactly one of the two record kinds and this
    // has no business knowing which: `#rememberDormant` no-ops for a provider
    // session (no `resume` capability) and `#persistLive` no-ops for a claude or
    // codex one (no `snapshot()`). Without this half, a renamed provider session
    // survives the listing and comes back under its old title — the same bug
    // this method was added for, one engine over.
    void this.#persistLive(runner)
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
      if (isDormant(record)) {
        continue
      }
      for (const execution of record.executions) {
        this.#track(record.id, execution, floor)
      }
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
          // One call of a multi-call park settling leaves the session parked on
          // the rest — it has to go back down, and no new status_changed will say so.
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
          // The write-through moment: a turn has ended, so the history is whole
          // and the snapshot is cheap to justify.
          void this.#persistLive(runner)
          return
        }
        case 'permission_mode_changed':
        case 'model_changed': {
          // Both are part of what "the session is still there" means, and both
          // can be flipped between turns — so neither is covered by turn_result
          // alone. Flipped *mid*-turn, `snapshot()` refuses (a turn is in
          // flight) and the turn's own write covers it a moment later.
          void this.#persistLive(runner)
          return
        }
        case 'system_init': {
          // The first moment a resume is even possible: before the engine names
          // its session there is nothing to come back to.
          void this.#rememberDormant(runner)
          return
        }
        case 'conversation_reset': {
          // A clear invalidates whichever record this session has, and nothing else re-writes
          // one: no `status_changed` follows a clear, and `#persistLive` is otherwise driven by
          // `turn_result`. Skip either call and a restart in this window wakes the session back
          // into the transcript the user threw away.
          void this.#rememberDormant(runner)
          void this.#persistLive(runner)
          return
        }
        case 'session_closed': {
          // Not during shutdown. The registry closes every runner on the way
          // down and the reason it gives is the same 'server' a DELETE produces,
          // so the *only* thing separating "this session is over" from "this
          // process is over" is that `close()` ran first — which is exactly why
          // it does (`server.ts` closes parking before the registry). Without
          // this guard a graceful restart forgets every dormant session it was
          // supposed to preserve.
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

  /** A client detached: park the session if that was the last one watching. */
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
    return records.filter((record) => this.#options.registry.get(record.id) === undefined).map((record) => record.info)
  }

  /** The live runner for a session, rehydrating a parked one on demand. Undefined
   * when the session is neither live nor parked. */
  async ensureLive(id: string): Promise<Runner | undefined> {
    const live = this.#options.registry.get(id)
    if (live) {
      return live
    }
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
  async submitResult(executionId: string, result: ToolExecutionResult): Promise<{ applied: boolean; sessionId: string } | undefined> {
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
    if (applied) {
      this.#forget(executionId)
    }
    return { applied, sessionId }
  }

  /** Drop a parked session for good: the run is over (closed, canceled, killed). */
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

  /**
   * Write (or refresh) the dormant record that lets this session survive a restart. Cheap and
   * repeated on purpose, because the alternative is a shutdown hook and a `kill -9` runs none.
   *
   * Four gates, each of which would otherwise produce a record worse than none: the engine can
   * resume, it has named its session, the config to rebuild from is remembered, and **the runner
   * is still the registry's** — an evicted runner's late event must not overwrite a park.
   */
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
      // Checked LAST on purpose. The other three guards are what keep this from
      // touching a record that isn't ours to touch — most of all the ownership
      // one, since `#park` evicts before it saves and a parked record must
      // survive a late event from the runner it replaced.
      //
      // Nothing to come back to. Before the engine has ever named its session
      // that is just the normal startup window and there is no record to
      // remove; after a `conversation_reset` it means the record we wrote names
      // a conversation that has been cleared. `#remembered` separates the two,
      // so the ordinary case costs no store write.
      if (this.#remembered.has(runner.id)) {
        await this.#forgetDormant(runner.id)
      }
      return
    }
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
      // Marked BEFORE the write, not after. The flag's job is "a record for this
      // session may exist on disk", and a save that is merely *queued* already
      // makes that true — a `conversation_reset` arriving mid-write would
      // otherwise see `false`, skip the forget, and let the stale record land
      // behind it. Over-claiming costs one delete of a key that isn't there;
      // under-claiming costs the bug this whole arm exists to fix.
      this.#remembered.add(runner.id)
      await this.#queue(runner.id, () => this.#options.store.save(record))
    } catch (error) {
      // Losing this costs the session its way back after a restart, and nothing
      // else — the live session is untouched.
      this.#options.onError?.(error, { sessionId: runner.id, phase: 'remember' })
    }
  }

  /**
   * Drop a dormant record that has stopped being true, leaving the live session
   * alone — the narrow counterpart to {@link SessionParkManager.discard}, which also
   * forgets the config and the session's executions and would therefore make a
   * clear cost the session its ability to go dormant ever again.
   *
   * Only ever called behind `#rememberDormant`'s guards,
   * which is what keeps it off a parked record: a park evicts the runner from
   * the registry before it saves, and the ownership guard turns a late event
   * from an evicted runner into a no-op.
   */
  async #forgetDormant(sessionId: string): Promise<void> {
    this.#remembered.delete(sessionId)
    try {
      await this.#queue(sessionId, () => this.#options.store.delete(sessionId))
    } catch (error) {
      // Same posture as a failed save: the live session is untouched, and the
      // worst case is the stale record we were trying to remove.
      this.#options.onError?.(error, { sessionId, phase: 'remember' })
    }
  }

  /**
   * Write a live session's snapshot through to the store — `#rememberDormant`'s counterpart for
   * the engine with no engine-side session to resume from: that one remembers *where* the
   * transcript is, this one carries it. Same gates, plus the option and the engine's ability.
   *
   * **This must not run synchronously inside the event listener.** `turn_result` is emitted from
   * inside the turn, before the `finally` that clears the abort controller, so a `snapshot()`
   * called straight from the listener sees a turn in flight and refuses — every time, silently.
   * `#queue`'s microtask hop is what puts the call after it.
   */
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
        // Re-checked inside the queue: this runs a tick or more after the event,
        // and the session may have parked or been evicted in between — a park's
        // record must not be overwritten by the live copy queued behind it.
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
          // Idle, never the live status: a record that came back saying
          // `running` would show a spinner over a session with no process, and
          // one saying `parked` would claim it waits on work it does not have.
          info: { ...info, status: 'idle' },
          profile: info.profile,
          // `info.meta` IS the runner's live `#config.meta`, and `#configs`
          // never sees a rename — the same reason `#rememberDormant` spells it
          // this way. Without it a renamed session comes back under its old
          // title, having listed correctly right up until the restart.
          config: { ...config, meta: info.meta },
          snapshot,
          // Whatever it is waiting on, which is empty for the ordinary idle
          // write and is *not* for the case that matters: a session parked on
          // deferred work stays live while a client is attached (`#park` defers
          // to the socket), so this record is its only durable one and `hydrate`
          // re-arms the watchdogs from exactly this list.
          executions: snapshot.parked,
          parkedAt: Date.now(),
        }
        await this.#options.store.save(record)
      })
    } catch (error) {
      // Losing this costs the session its way back after a restart, and nothing
      // else — the live session is untouched. Same phase as the dormant write:
      // they are the same operation for different engines.
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
    // Someone is watching: keep it live and reconsider when they leave.
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
    // park() → evict in one tick: an attach landing between them would bind a
    // client to a runner that is already inert.
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
      // The runner is already inert and evicted; without the record the session
      // cannot come back. Nothing to roll back to — surface it loudly.
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
    // A park's record *is* the session — consumed on wake. A dormant one, and a
    // live one, are a way back that the session still needs the next time the
    // process dies, so they stay and are refreshed in place; `listInfo` already
    // hides them while the registry has the session, and `discard` removes them
    // when the session ends.
    //
    // Consuming a live record here would be the feature's worst bug rather than
    // a tidier lifecycle: it opens a window from this attach to the next turn in
    // which the session exists nowhere durable, so someone who opens a session,
    // reads it and types nothing loses it to a redeploy — with no error and no
    // trace.
    if (!isDormant(record) && !isLiveRecord(record)) {
      await this.#queue(id, () => this.#options.store.delete(id))
    }
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
