import type { CounterBase, Runner, SessionRunnerConfig } from '@workerdeck/core'
import {
  ENGINE_CAPABILITIES,
  INPUT_CHANGED_CODE,
  UNCERTAIN_PROMPT_CODE,
  UNCONFIRMED_INPUT_CODE,
  errorMessage,
  isJobRun,
  type ConversationTarget,
  type SessionInfo,
  type UncertainPromptRefusal,
  type UnconfirmedInputRefusal,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, HttpError } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
import { freshRecord, requestedConfig, type ConversationEntry, type SessionCut, type SessionRecord } from './session-records.ts'
import { durableConfig, isDormant, type DormantSessionRecord, type StoredSessionRecord } from './session-store.ts'

export type CutReason = 'user' | 'clear' | 'context_reset'

// `discard`: a person confirmed losing the input pending at `revision`; only a user cut carries it, never an automatic one.
export type CutRequest = {
  expectedGeneration: number
  prompt?: string
  // A `context_reset`'s own reason, shown as the notice opening the new conversation.
  agentReason?: string
  reason: CutReason
  target?: ConversationTarget
  discard?: { revision: string }
}

export type CutResult = { session: SessionInfo; conversation: number }

// A socket attached to one conversation: detached quietly at the stop, told and closed once the commit is durable.
export type CutSocket = {
  conversation: number
  detach: () => void
  announce: (conversation: number, epoch: number) => void
  drop: () => void
}

export type EndedExecution = { id: string; entry: ConversationEntry }

export type CutGuard = (record: SessionRecord | null) => Promise<void> | void

export type CutFault = 'commit' | 'start' | 'after-stop' | 'after-commit'

export const CONVERSATION_ENDED = 'this conversation has ended; reattach to the current one'
export const UNANSWERED_REFUSAL = 'the session has a message it has not answered yet; start a new conversation once it has'
export const UNCONFIRMED_INPUT =
  'the engine cannot confirm queued input was consumed; send a message and wait for its reply, then try again'
export { UNCONFIRMED_INPUT_CODE }
export const INPUT_CHANGED = 'new input arrived since the discard was confirmed; review it and confirm again'
export const NO_LONGER_CONFIRMABLE =
  'the session stopped since the discard was confirmed and its pending input went with it; start a new conversation'
export const NOTHING_TO_DISCARD = 'this engine has no pending input a discard can bind'
export const STILL_STARTING = 'the session is still starting; try again once it has started'
export const JOB_CUT_REFUSAL = 'a job run cannot start a new conversation'
export const GENERATION_ENDED = 'the gateway is reloading; the next one finishes this new conversation'
export const UNCERTAIN_PROMPT =
  'a message may not have reached the session; choose Send again or Dismiss for it before starting a new conversation'
export const WOKE_DURING_CUT = 'the session woke while the new conversation was being prepared; try again'
export const QUEUED_CUT_RELOADED = 'the gateway reloaded before the session went idle; ask for the new conversation again'
export const UNANSWERED_STALLED =
  'the session is idle but holds a message it never confirmed answering; use New conversation to review and discard it'

// Why a queued cut did not happen, for the person who asked; undefined when it did, or when the session simply ended.
export type CutOutcome = (cut: boolean, reason?: string) => void

export class ConversationCuts {
  #context: ServerContext | undefined
  #sockets = new Map<string, Set<CutSocket>>()
  #ended = new Map<string, EndedExecution>()
  #leaving = new Map<string, string>()
  #queued = new Map<string, { runner: Runner; leave: (why?: string) => void }>()
  #waiting = new Map<string, CutOutcome[]>()
  #failedStarts = new Set<string>()
  // The runner whose start may still settle n's intent; a superseded attempt's late settle is a no-op.
  #attempts = new Map<string, Runner>()
  #firstStarts = new Map<string, Promise<void>>()
  #closed = false
  // Test seam: a step named here throws, standing in for a crash or a refused write at that boundary.
  readonly faults = new Set<CutFault>()
  // How long a cut queued on an idle session waits for the turn its unanswered input should start.
  stallMs = 10_000

  bind(ctx: ServerContext): void {
    this.#context = ctx
  }

  // The generation is ending: a start still settling in the background is left as its intent for the next one to recover,
  // never failed because shutdown closed its runner.
  close(): void {
    this.#closed = true
    this.#attempts.clear()
    for (const { leave } of this.#queued.values()) {
      leave(QUEUED_CUT_RELOADED)
    }
  }

  // Whether a cut waits on this session's next idle.
  queued(id: string): boolean {
    return this.#queued.has(id)
  }

  get #ctx(): ServerContext {
    return this.#context!
  }

  socket(id: string, socket: CutSocket): () => void {
    const set = this.#sockets.get(id) ?? new Set()
    set.add(socket)
    this.#sockets.set(id, set)
    return () => {
      set.delete(socket)
    }
  }

  // A rewritten entry replaces the cached one its executions authorize against: an erase (its 409 kept, nothing of the
  // erased payload behind it) or an owner rename.
  refreshEntry(id: string, entry: ConversationEntry): void {
    this.#remember(id, entry)
  }

  endedExecution(executionId: string): EndedExecution | undefined {
    return this.#ended.get(executionId)
  }

  // The session of an execution whose conversation is being cut: parking forgot it at the stop, the history has not got it yet.
  leavingExecution(executionId: string): string | undefined {
    return this.#leaving.get(executionId)
  }

  // `guard` runs inside the lifecycle lock on the record as it is then: the caller's own check of the current
  // conversation and of its sight of the session, so nothing it decided before the lock can be acted on after it.
  async cut(id: string, request: CutRequest, guard?: CutGuard): Promise<CutResult> {
    const first = this.#firstStarts.get(id)
    if (
      first &&
      (await within(
        first.then(() => true),
        this.#ctx.locks.startupTimeoutMs,
      )) === undefined
    ) {
      fail(409, STILL_STARTING)
    }
    return await this.#ctx.locks.run([id], () => this.#cut(id, request, guard))
  }

  // A create's first message is handed to the engine at its start: from here a crash leaves it `uncertain`, never resent.
  async handingOff(id: string): Promise<void> {
    await this.#ctx.records.transactDurable(id, (current) => {
      const prompt = current?.pendingPrompt
      return prompt?.n === 1 && prompt.state === 'pending' && current!.cut?.from === 0
        ? { ...current!, pendingPrompt: { ...prompt, state: 'sending' } }
        : current!
    })
  }

  // The create's start intent stays until the first conversation is durable, as a cut's does; it settles in the
  // background, so the create answers at once and a later cut waits for it.
  firstStarted(runner: Runner): void {
    const ctx = this.#ctx
    const id = runner.id
    const settled = (async () => {
      const record = await ctx.records.get(id)
      if (record?.cut?.from !== 0) {
        return
      }
      const identity = record.pendingPrompt?.n === 1
      this.#attempts.set(id, runner)
      const startup = await startupOf(ctx, runner, identity)
      if (this.#closed) {
        return
      }
      await ctx.locks.run([id], () => this.#settle(id, 1, { uncertain: false, identity }, runner, startup, false))
    })()
      .catch((error: unknown) => ctx.locks.onError(error))
      .finally(() => {
        if (this.#firstStarts.get(id) === settled) {
          this.#firstStarts.delete(id)
        }
      })
    this.#firstStarts.set(id, settled)
  }

  // The one rule for every door that asks while a turn runs: the cut waits for the next idle. `outcome` hears whether a
  // queued cut happened (true) or was dropped, failed before its commit, or lost its runner (false).
  async clearOnIdle(
    runner: Runner,
    reason: CutReason,
    prompt?: string,
    outcome?: CutOutcome,
    agentReason?: string,
  ): Promise<CutResult | undefined> {
    const ctx = this.#ctx
    if (isJobRun(runner.info())) {
      fail(409, JOB_CUT_REFUSAL)
    }
    const n = ctx.records.conversationOf(runner.id) ?? 1
    refuseUnconfirmed(runner, n)
    refuseUncertainPrompt(await ctx.records.get(runner.id))
    // Another door may have cut while the record was read: this request was made of n's runner and never reaches n+1.
    const now = ctx.records.conversationOf(runner.id) ?? 1
    if (this.#closed || ctx.registry.get(runner.id) !== runner || now !== n || runner.info().status === 'closed') {
      fail(409, `the session moved on to conversation ${now}`)
    }
    if (runner.info().status === 'idle' && !unanswered(runner)) {
      return await this.cut(runner.id, { expectedGeneration: n, reason, ...(prompt ? { prompt } : {}), ...(agentReason ? { agentReason } : {}) })
    }
    this.#queueOnIdle(runner, n, reason, prompt, outcome, agentReason)
    return undefined
  }

  #queueOnIdle(
    runner: Runner,
    from: number,
    reason: CutReason,
    prompt: string | undefined,
    outcome: CutOutcome | undefined,
    agentReason?: string,
  ): void {
    const ctx = this.#ctx
    const id = runner.id
    const stale = this.#queued.get(id)
    if (stale && stale.runner !== runner) {
      stale.leave()
    }
    const waiting = this.#waiting.get(id) ?? []
    if (outcome) {
      waiting.push(outcome)
    }
    this.#waiting.set(id, waiting)
    if (this.#queued.has(id)) {
      return
    }
    // Level-triggered: the state is read again on every event and when the stall bound expires, never inferred from
    // one transition, because a status that is already idle emits nothing more. Idle with unanswered input is a turn
    // about to start or input the engine took and never confirmed; only the bound tells them apart.
    let stall: ReturnType<typeof setTimeout> | undefined
    let stalled = false
    const drop = (why: string): void => {
      tell(leave(), false, why)
      ctx.locks.onError(new Error(`${reason} for ${id} dropped: ${why}`))
    }
    const evaluate = (closed = false): void => {
      if (this.#queued.get(id)?.runner !== runner) {
        return
      }
      if (closed || this.#closed || runner.info().status === 'closed') {
        tell(leave(), false)
        return
      }
      if (runner.info().status !== 'idle') {
        clearTimeout(stall)
        stall = undefined
        stalled = false
        return
      }
      if (!unanswered(runner)) {
        const heard = leave()
        this.cut(id, { expectedGeneration: from, reason, ...(prompt ? { prompt } : {}), ...(agentReason ? { agentReason } : {}) }).then(
          () => tell(heard, true),
          (error: unknown) => {
            const cut = (ctx.records.conversationOf(id) ?? 1) > from
            tell(heard, cut, cut ? undefined : errorMessage(error))
            ctx.locks.onError(new Error(`${reason} for ${id} dropped: ${errorMessage(error)}`))
          },
        )
        return
      }
      if (runner.inputConfirmable?.() === false) {
        drop(UNCONFIRMED_INPUT)
        return
      }
      if (stalled) {
        drop(UNANSWERED_STALLED)
        return
      }
      stall ??= setTimeout(() => {
        stalled = true
        evaluate()
      }, this.stallMs)
      stall.unref?.()
    }
    const leave = (): CutOutcome[] => {
      clearTimeout(stall)
      this.#queued.delete(id)
      unsubscribe()
      const heard = this.#waiting.get(id) ?? []
      this.#waiting.delete(id)
      return heard
    }
    const tell = (heard: CutOutcome[], cut: boolean, why?: string): void => {
      for (const listener of heard) {
        listener(cut, why)
      }
    }
    const unsubscribe = runner.subscribe((event) => evaluate(event.type === 'session_closed'), runner.info().lastSeq)
    this.#queued.set(id, { runner, leave: (why) => tell(leave(), false, why) })
    evaluate()
  }

  async #cut(id: string, request: CutRequest, guard: CutGuard | undefined): Promise<CutResult> {
    const ctx = this.#ctx
    const record = await ctx.records.get(id)
    await guard?.(record)
    if (record?.closedAt !== undefined || ctx.agents.tombstone(id)) {
      fail(404, 'session not found')
    }
    const conversation = record?.conversation ?? 1
    if (request.expectedGeneration !== conversation) {
      fail(409, `the session moved on to conversation ${conversation}`)
    }
    if (record?.cut) {
      fail(409, 'a new conversation is still starting')
    }
    if (record?.startFailed) {
      fail(409, 'the new conversation did not start; retry starting it first')
    }
    refuseUncertainPrompt(record)
    const live = ctx.registry.get(id)
    const stored = live ? null : await ctx.parking.get(id)
    const info = live?.info() ?? stored?.info
    if (!info) {
      fail(404, 'session not found')
    }
    if (isJobRun(info)) {
      fail(409, JOB_CUT_REFUSAL)
    }
    if (live && info.status !== 'idle') {
      fail(409, 'the session is busy; start a new conversation once it is idle')
    }
    if (request.discard) {
      if (!live) {
        fail(409, NO_LONGER_CONFIRMABLE)
      }
      refuseChangedInput(live, conversation, request.discard.revision)
    } else if (live && unanswered(live)) {
      const message = live.inputConfirmable?.() === false ? UNCONFIRMED_INPUT : UNANSWERED_REFUSAL
      fail(409, message, UNCONFIRMED_INPUT_CODE, unconfirmedDetails(live, conversation))
    }
    if (stored && !isDormant(stored)) {
      fail(409, 'the session is parked mid-turn')
    }
    const target = this.#target(record?.requested ?? record?.running ?? stored?.config ?? ctx.parking.configOf(id), request.target)

    ctx.locks.gate(id)
    try {
      await ctx.parking.fence(id)
      // A wake already under way when the checks ran registers before the fence settles: that runner was never vetted.
      if (ctx.registry.get(id) !== live) {
        fail(409, WOKE_DURING_CUT)
      }
      const entry = await this.#capture(id, record, conversation)
      for (const executionId of entry.executions) {
        this.#leaving.set(executionId, id)
      }
      const cut: SessionCut = {
        from: conversation,
        to: conversation + 1,
        phase: 'prepared',
        epoch: (info.epoch ?? 0) + 1,
        target,
        ...(request.agentReason ? { agentReason: request.agentReason } : {}),
        counters: lifetimeCounters(record?.counters, info),
      }
      await ctx.records.transactDurable(id, (current) => ({ ...(current ?? freshRecord(id)), cut }))
      // A hot reload carried the runner away while the intent was being written: it is the next generation's now.
      if (this.#closed || (live && ctx.registry.get(id) !== live)) {
        await this.#rollback(id)
        fail(503, GENERATION_ENDED)
      }

      this.#stop(id, live)
      this.#fault('after-stop')

      let committed: SessionRecord
      try {
        this.#fault('commit')
        committed = await ctx.records.transactDurable(id, (current) => this.#commit(current ?? freshRecord(id), entry, cut, request, info))
      } catch (error) {
        await this.#rollback(id)
        this.#drop(id)
        throw error
      }
      this.#remember(id, entry)
      this.#fault('after-commit')
      return await this.#startCommitted(committed)
    } finally {
      for (const [executionId, owner] of this.#leaving) {
        if (owner === id) {
          this.#leaving.delete(executionId)
        }
      }
      ctx.locks.ungate(id)
      if (!this.#failedStarts.has(id)) {
        ctx.parking.unfence(id)
      }
    }
  }

  // Before listen. `prepared` rolls back (nothing was cut), `committed` starts n+1 once, `sending` becomes `uncertain`.
  async recover(onError: (error: unknown) => void): Promise<void> {
    const ctx = this.#ctx
    for (const record of await ctx.records.list()) {
      for (const entry of record.conversations) {
        this.#remember(record.id, entry)
      }
      try {
        await ctx.locks.run([record.id], async () => {
          const current = await ctx.records.get(record.id)
          if (current?.cut?.phase === 'prepared') {
            await this.#rollback(record.id)
          } else if (current?.cut?.phase === 'committed') {
            await this.#startCommitted(current)
          } else if (current?.pendingPrompt?.state === 'sending') {
            const prompt = current.pendingPrompt
            await ctx.records.transactDurable(record.id, (latest) => ({ ...latest!, pendingPrompt: { ...prompt, state: 'uncertain' } }))
          }
        })
      } catch (error) {
        onError(error)
      }
    }
  }

  // The same n again, never a second cut.
  retryStart(id: string, guard: CutGuard): Promise<CutResult> {
    const ctx = this.#ctx
    return ctx.locks.run([id], async () => {
      const record = await ctx.records.get(id)
      await guard(record)
      if (!record?.startFailed || record.cut?.phase !== 'committed') {
        fail(409, 'no new conversation is waiting to start')
      }
      this.#failedStarts.delete(id)
      const stuck = ctx.registry.get(id)
      if (stuck) {
        ctx.registry.evict(id)
        stuck.close('server')
      }
      ctx.parking.unfence(id)
      return await this.#startCommitted(record)
    })
  }

  settlePendingPrompt(id: string, send: boolean, guard: CutGuard): Promise<void> {
    const ctx = this.#ctx
    return ctx.locks.run([id], async () => {
      const record = await ctx.records.get(id)
      await guard(record)
      const prompt = record?.pendingPrompt
      if (!record || prompt?.state !== 'uncertain') {
        fail(404, 'nothing is waiting to be sent')
      }
      if (send) {
        const runner = await ctx.parking.ensureLive(id)
        if (!runner || prompt.n !== record.conversation) {
          fail(409, 'the conversation it was for has ended')
        }
        await ctx.records.transactDurable(id, (current) => ({ ...current!, pendingPrompt: { ...prompt, state: 'sending' } }))
        runner.sendMessage(prompt.text)
      }
      await ctx.records.transactDurable(id, (current) => withoutPendingPrompt(current!))
    })
  }

  // An unnamed close: the current conversation joins the history, which stays readable on the closed record.
  // The caller holds the session's lifecycle lock and has re-checked the conversation and the caller's sight of it.
  // `holdOnFailure`: a failed close leaves the fence up, for a retirement that must not let the session work again.
  async closeLocked(id: string, options: { holdOnFailure?: boolean } = {}): Promise<void> {
    const ctx = this.#ctx
    await ctx.parking.fence(id)
    let closed = false
    try {
      const record = await ctx.records.get(id)
      if (record?.closedAt !== undefined) {
        closed = true
        return
      }
      if (!record) {
        closed = true
        return
      }
      // A session that ended without durable state has nothing to capture; it still closes, its history kept.
      const entry = await this.#capture(id, record, record.conversation).catch(() => undefined)
      await ctx.records.transactDurable(id, (current) => {
        const {
          runtime: _runtime,
          cut: _cut,
          pendingPrompt: _prompt,
          startFailed: _failed,
          identity: _identity,
          ...rest
        } = current ?? freshRecord(id)
        return { ...rest, conversations: entry ? [...rest.conversations, entry] : rest.conversations, closedAt: Date.now() }
      })
      if (entry) {
        this.#remember(id, entry)
      }
      closed = true
    } finally {
      if (closed || !options.holdOnFailure) {
        ctx.parking.unfence(id)
      }
    }
  }

  #commit(current: SessionRecord, entry: ConversationEntry, cut: SessionCut, request: CutRequest, info: SessionInfo): SessionRecord {
    const next = cut.to
    return {
      ...current,
      conversation: next,
      conversations: [...current.conversations, entry],
      running: cut.target,
      ...(request.target ? { requested: cut.target } : {}),
      ...(request.target?.scope ? { scope: cut.target.scope } : {}),
      runtime: this.#freshRuntime(current.id, cut, info),
      cut: { ...cut, phase: 'committed' },
      ...(cut.counters ? { counters: cut.counters } : {}),
      ...(request.prompt ? { pendingPrompt: { text: request.prompt, n: next, state: 'pending' as const } } : {}),
    }
  }

  // Wakes into a fresh conversation n+1 if the process dies before the start: no engine id to resume.
  #freshRuntime(id: string, cut: SessionCut, info: SessionInfo): DormantSessionRecord {
    const ctx = this.#ctx
    const { target } = cut
    const profile = target.profile === undefined ? undefined : ctx.profiles.get(target.profile)
    const engine = engineOf(profile)
    return {
      kind: 'dormant',
      id,
      info: {
        id,
        status: 'idle',
        cwd: target.cwd ?? info.cwd,
        ...(target.profile ? { profile: target.profile } : {}),
        engine,
        capabilities: profile?.capabilities ?? ctx.adapterFor(engine).capabilities,
        ...(target.model ? { model: target.model } : {}),
        ...(target.permissionMode ? { permissionMode: target.permissionMode } : {}),
        createdAt: info.createdAt,
        lastSeq: 0,
        epoch: cut.epoch,
        conversation: cut.to,
        pendingPermissionCount: 0,
        ...(cut.counters ? { activityCount: cut.counters.activity, proseCount: cut.counters.prose } : {}),
        ...(info.owner ? { owner: info.owner } : {}),
        ...(target.scope ? { scope: target.scope } : {}),
        ...(target.meta ? { meta: target.meta } : {}),
      },
      ...(target.profile ? { profile: target.profile } : {}),
      config: { ...target, epoch: cut.epoch, ...(cut.counters ? { counterBase: cut.counters } : {}) },
      savedAt: Date.now(),
    }
  }

  async #capture(id: string, record: SessionRecord | null, n: number): Promise<ConversationEntry> {
    const ctx = this.#ctx
    const archive = await ctx.parking.capture(id)
    if (!archive) {
      fail(500, 'the session has nothing to capture')
    }
    const { info } = archive
    const engine = engineOf(info)
    const running = record?.running ?? durableConfig(archive.config)
    return {
      n,
      engine,
      ...(archive.profile ? { profile: archive.profile } : {}),
      ...(archive.home ? { engineHome: archive.home } : {}),
      cwd: info.cwd,
      ...(archive.engineSessionId ? { engineSessionId: archive.engineSessionId } : {}),
      ...(engine === 'provider' && archive.snapshot ? { snapshot: archive.snapshot } : {}),
      running,
      ...(info.title ? { title: info.title } : {}),
      ...(info.totalCostUsd === undefined ? {} : { costUsd: info.totalCostUsd }),
      startedAt: record?.conversations.at(-1)?.endedAt ?? record?.createdAt ?? info.createdAt,
      endedAt: Date.now(),
      executions: ctx.parking.executionsOf(id),
      auth: { ...(info.owner ? { owner: info.owner } : {}), ...(info.scope ? { scope: info.scope } : {}) },
    }
  }

  // Quiet: the watchers come off before the close, so no `session_closed` webhook, push or notification goes out
  // for a session that is not ending. Its shells still die, as they would on any stop.
  #stop(id: string, live: Runner | undefined): void {
    const ctx = this.#ctx
    for (const socket of this.#sockets.get(id) ?? []) {
      socket.detach()
    }
    if (live) {
      const running = ctx.shells?.list(id).filter((shell) => shell.status === 'running') ?? []
      ctx.registry.evict(id)
      for (const shell of running) {
        ctx.shells?.kill(id, shell.id, 'killed')
      }
      live.close('server')
    }
    ctx.bridge.remove(id)
    ctx.parking.dropExecutions(id)
  }

  // The intent stays until the successor is durable: a runtime for n+1 that names its engine conversation (or a live
  // snapshot, for an engine without resume). One that already exists is resumed, never replaced, and a prompt whose
  // delivery is not known is never resent.
  async #startCommitted(record: SessionRecord): Promise<CutResult> {
    const ctx = this.#ctx
    const id = record.id
    const cut = record.cut!
    const intent = record.pendingPrompt?.n === cut.to ? record.pendingPrompt : undefined
    const live = ctx.registry.get(id)
    if (!live && cut.from === 0 && record.identity) {
      const refused = await this.#restoreIdentity(record)
      if (refused !== undefined) {
        await this.#failStart(id, cut.to, refused, false)
        fail(409, `the named session did not start: ${refused}`)
      }
    }
    if (!live && record.runtime && successorKept(record.runtime, cut.to)) {
      await this.#confirm(id, cut.to, intent !== undefined)
      this.#announce(id, cut.to, cut.epoch)
      return { session: ctx.projects.withProject(record.runtime.info), conversation: cut.to }
    }
    const prompt = !live && intent?.state === 'pending' ? intent.text : undefined
    // A successor carried across a hot reload was started with the prompt: as delivered as a start this process made.
    const carried = live !== undefined && intent?.state === 'sending' && ctx.parking.configOf(id)?.prompt === intent.text
    const uncertain = intent !== undefined && prompt === undefined && !carried
    let runner = live
    if (!runner) {
      this.#refuseClosed()
      this.#attempts.delete(id)
      // A replacement attempt begins: an earlier one's failure is no longer the record's to report.
      await ctx.records.transactDurable(id, (current) => {
        const { startFailed: _failed, ...rest } = current!
        return prompt === undefined ? rest : { ...rest, pendingPrompt: { ...intent!, state: 'sending' } }
      })
      this.#refuseClosed()
      try {
        this.#fault('start')
        runner = await this.#startFresh(id, cut, prompt)
      } catch (error) {
        if (generationEnded(error)) {
          throw error
        }
        await this.#failStart(id, cut.to, errorMessage(error), prompt !== undefined)
        this.#announce(id, cut.to, cut.epoch)
        fail(502, `the new conversation did not start: ${errorMessage(error)}`)
      }
    }
    const started = runner
    this.#attempts.set(id, started)
    const owed: Owed = { uncertain, identity: prompt !== undefined || carried }
    const startup = startupOf(ctx, started, owed.identity)
    const early = await within(startup, ctx.locks.startupTimeoutMs)
    if (early) {
      try {
        await this.#settle(id, cut.to, owed, started, early, true)
      } finally {
        this.#announce(id, cut.to, cut.epoch)
      }
      return { session: ctx.projects.withProject(started.info()), conversation: cut.to }
    }
    void startup
      .then((late) => (this.#closed ? undefined : ctx.locks.run([id], () => this.#settle(id, cut.to, owed, started, late, false))))
      .catch((error: unknown) => ctx.locks.onError(error))
    this.#announce(id, cut.to, cut.epoch)
    return { session: ctx.projects.withProject(started.info()), conversation: cut.to }
  }

  // `strict` answers the caller, so a failure throws; otherwise it settles in the background for nobody.
  async #settle(id: string, to: number, owed: Owed, runner: Runner, startup: Startup, strict: boolean): Promise<void> {
    if (this.#closed || this.#attempts.get(id) !== runner) {
      return
    }
    try {
      await this.#settleOwned(id, to, owed, runner, startup, strict)
    } finally {
      if (this.#attempts.get(id) === runner) {
        this.#attempts.delete(id)
      }
    }
  }

  async #settleOwned(id: string, to: number, owed: Owed, runner: Runner, startup: Startup, strict: boolean): Promise<void> {
    const record = await this.#ctx.records.get(id)
    if (record?.cut?.phase !== 'committed' || record.cut.to !== to || (!strict && record.startFailed !== undefined)) {
      return
    }
    const failure = startup.kind === 'failed' ? startup.error : await this.#durability(id, to, runner, owed.identity)
    if (failure === undefined) {
      await this.#confirm(id, to, owed.uncertain)
      return
    }
    if ((await this.#failStart(id, to, failure, false)) && strict) {
      fail(502, `the new conversation did not start: ${failure}`)
    }
  }

  // Read back, never assumed from a flush. An engine with neither resume nor a live snapshot has nothing to keep.
  async #durability(id: string, to: number, runner: Runner, identity: boolean): Promise<string | undefined> {
    const ctx = this.#ctx
    const info = runner.info()
    const resumable = (info.capabilities ?? ENGINE_CAPABILITIES[engineOf(info)]).resume
    if (!resumable && !ctx.parking.persistsLive(runner)) {
      return undefined
    }
    if (await this.#recorded(id, to, runner, resumable, identity)) {
      return undefined
    }
    ctx.parking.touch(runner)
    await ctx.parking.flush(id)
    return (await this.#recorded(id, to, runner, resumable, identity)) ? undefined : 'the new conversation could not be saved'
  }

  async #recorded(id: string, to: number, runner: Runner, resumable: boolean, identity: boolean): Promise<boolean> {
    const runtime = (await this.#ctx.records.get(id))?.runtime
    if (!runtime || runtime.info.conversation !== to) {
      return false
    }
    if (!resumable) {
      return runtime.kind === 'live'
    }
    const named = runner.info().sdkSessionId
    if (named === undefined) {
      return !identity
    }
    return !isDormant(runtime) || runtime.sdkSessionId === named
  }

  // A named first start never runs without its index row: the row is there, or written now from the record's copy
  // under the same validation, or the start is refused (a name taken since) and stays recoverable.
  async #restoreIdentity(record: SessionRecord): Promise<string | undefined> {
    const ctx = this.#ctx
    const pending = record.identity!
    if (ctx.agents.get(record.id)) {
      return undefined
    }
    if (pending.remoteLead !== undefined) {
      return 'its join to a team on another gateway did not finish; name it again'
    }
    const created = await ctx.agents.create(pending.agent, undefined, pending.crossOwner === true)
    return 'error' in created && 'status' in created ? created.error : undefined
  }

  async #confirm(id: string, to: number, uncertain: boolean): Promise<void> {
    this.#failedStarts.delete(id)
    await this.#owned(id, to, (current) => {
      const { cut: _done, startFailed: _failed, identity: _identity, pendingPrompt, ...rest } = current!
      const lost = uncertain && pendingPrompt?.n === to
      return lost ? { ...rest, pendingPrompt: { ...pendingPrompt, state: 'uncertain' } } : rest
    })
  }

  // False when the intent is no longer this generation's to fail.
  async #failStart(id: string, to: number, error: string, unsent: boolean): Promise<boolean> {
    const ctx = this.#ctx
    if (this.#closed) {
      return false
    }
    this.#failedStarts.add(id)
    void ctx.parking.fence(id)
    return await this.#owned(id, to, (current) => {
      const prompt = current!.pendingPrompt
      return {
        ...current!,
        startFailed: { n: to, error },
        ...(unsent && prompt?.n === to ? { pendingPrompt: { ...prompt, state: 'pending' as const } } : {}),
      }
    })
  }

  #drop(id: string): void {
    for (const socket of this.#sockets.get(id) ?? []) {
      socket.drop()
    }
    this.#sockets.delete(id)
  }

  // A socket that attached while n+1 started is already on it: it stays, and the next cut finds it.
  #announce(id: string, conversation: number, epoch: number): void {
    const sockets = this.#sockets.get(id)
    for (const socket of sockets ?? []) {
      if (socket.conversation < conversation) {
        sockets!.delete(socket)
        socket.announce(conversation, epoch)
      }
    }
    if (sockets?.size === 0) {
      this.#sockets.delete(id)
    }
  }

  // An explicit fresh constructor: no resume, no fork, no restore, the target's own engine home, the committed epoch.
  async #startFresh(id: string, cut: SessionCut, prompt: string | undefined): Promise<Runner> {
    const ctx = this.#ctx
    const built = ctx.factory.buildRunnerConfig({ ...cut.target, prompt, resume: undefined, forkSession: undefined })
    const config: SessionRunnerConfig = { ...built, epoch: cut.epoch, ...(cut.counters ? { counterBase: cut.counters } : {}) }
    const runner = await ctx.factory.buildRunner(cut.agentReason ? { ...config, agentResetReason: cut.agentReason } : config, undefined, id)
    if (this.#closed) {
      runner.close('server')
      fail(503, GENERATION_ENDED)
    }
    if (runner.id !== id) {
      runner.close('error')
      throw new Error(`the engine built ${runner.id}, expected ${id}`)
    }
    ctx.parking.unfence(id)
    ctx.registry.register(runner)
    ctx.parking.remember(id, config)
    ctx.parking.watch(runner)
    void runner.start()
    return runner
  }

  async #rollback(id: string): Promise<void> {
    await this.#ctx.records.transactDurable(id, (current) => {
      const { cut: _dropped, ...rest } = current ?? freshRecord(id)
      return rest
    })
  }

  #target(base: SessionRunnerConfig | undefined, override: ConversationTarget | undefined): SessionRunnerConfig {
    const ctx = this.#ctx
    if (!base) {
      fail(500, 'the session has no config to start from')
    }
    const next: SessionRunnerConfig = requestedConfig(base)
    for (const [key, value] of Object.entries(override ?? {})) {
      if (value !== undefined) {
        ;(next as Record<string, unknown>)[key] = value
      }
    }
    if (override?.profile !== undefined) {
      const resolved = ctx.factory.resolveProfile(override.profile, undefined)
      if (!resolved.ok) {
        fail(resolved.status, resolved.error)
      }
      if (ctx.factory.checkPermissionMode(next.permissionMode, resolved.profile)) {
        delete next.permissionMode
      }
      if (override.model === undefined) {
        delete next.model
      }
    }
    const cwd = ctx.factory.checkCwd(next, next.profile === undefined ? undefined : ctx.profiles.get(next.profile))
    if (cwd) {
      fail(cwd.status, cwd.error)
    }
    return next
  }

  #remember(id: string, entry: ConversationEntry): void {
    for (const executionId of entry.executions) {
      this.#ended.set(executionId, { id, entry: withoutSnapshot(entry) })
    }
  }

  // A closed generation never starts an engine: its intent stays for the next generation's recovery.
  #refuseClosed(): void {
    if (this.#closed) {
      fail(503, GENERATION_ENDED)
    }
  }

  // A settling write runs only while this generation is open and the intent for `to` is still committed, checked as
  // the transaction runs: a reload or another settle may have moved it on during any await before it.
  async #owned(id: string, to: number, merge: (current: SessionRecord) => SessionRecord): Promise<boolean> {
    try {
      await this.#ctx.records.transactDurable(id, (current) => {
        if (this.#closed || current?.cut?.phase !== 'committed' || current.cut.to !== to) {
          throw NOT_OWNED
        }
        return merge(current)
      })
      return true
    } catch (error) {
      if (error === NOT_OWNED) {
        return false
      }
      throw error
    }
  }

  #fault(step: CutFault): void {
    if (this.faults.has(step)) {
      throw new Error(`injected fault at ${step}`)
    }
  }
}

const NOT_OWNED = new Error("the intent is no longer this generation's")

function generationEnded(error: unknown): boolean {
  return error instanceof HttpError && error.message === GENERATION_ENDED
}

function withoutSnapshot(entry: ConversationEntry): ConversationEntry {
  const { snapshot: _snapshot, ...rest } = entry
  return rest
}

function withoutPendingPrompt(record: SessionRecord): SessionRecord {
  const { pendingPrompt: _gone, ...rest } = record
  return rest
}

// `identity`: the start was handed a prompt, so only an engine conversation the successor named makes it durable.
type Owed = { uncertain: boolean; identity: boolean }

type Startup = { kind: 'ready' } | { kind: 'failed'; error: string }

// Input n's engine took and has not consumed (a peer's queued behind a turn, a person's): the cut waits for it to be
// answered in n, so it is never dropped with n's engine and never carried into n+1. The runner's own state decides.
function unanswered(runner: Runner): boolean {
  return (runner.pendingInput?.() ?? 0) > 0
}

// An engine that cannot confirm consumption never has its queued input guessed away: the cut is refused, distinctly,
// with what a person needs to confirm a discard of exactly this set.
// A cut would overwrite or strip the only durable copy of a prompt whose delivery a person has not settled yet.
function refuseUncertainPrompt(record: SessionRecord | null): void {
  const prompt = record?.pendingPrompt
  if (record && prompt?.state === 'uncertain') {
    const details: Omit<UncertainPromptRefusal, 'error' | 'code'> = { conversation: record.conversation, promptConversation: prompt.n }
    fail(409, UNCERTAIN_PROMPT, UNCERTAIN_PROMPT_CODE, details)
  }
}

export function refuseUnconfirmed(runner: Runner, conversation: number): void {
  if (unanswered(runner) && runner.inputConfirmable?.() === false) {
    fail(409, UNCONFIRMED_INPUT, UNCONFIRMED_INPUT_CODE, unconfirmedDetails(runner, conversation))
  }
}

// Synchronous up to the gate the caller raises next, so no send lands between this check and the gate.
function refuseChangedInput(runner: Runner, conversation: number, revision: string): void {
  const now = runner.inputSnapshot?.()
  if (!now) {
    fail(409, NOTHING_TO_DISCARD)
  }
  if (now.revision !== revision) {
    fail(409, INPUT_CHANGED, INPUT_CHANGED_CODE, unconfirmedDetails(runner, conversation))
  }
}

function unconfirmedDetails(runner: Runner, conversation: number): Omit<UnconfirmedInputRefusal, 'error' | 'code'> | undefined {
  const snapshot = runner.inputSnapshot?.()
  return snapshot
    ? { conversation, inputRevision: snapshot.revision, pendingInput: snapshot.pending, mayIncludePeer: snapshot.peer }
    : undefined
}

// A runtime for n+1 that the engine has named (or a live snapshot): the successor exists and is resumed, not replaced.
// The runner's counts already include the base it was built with; the max keeps a stored row that predates it from
// walking the lifetime back.
export function lifetimeCounters(base: CounterBase | undefined, info: Pick<SessionInfo, 'activityCount' | 'proseCount'>): CounterBase {
  return {
    activity: Math.max(base?.activity ?? 0, info.activityCount ?? 0),
    prose: Math.max(base?.prose ?? 0, info.proseCount ?? 0),
  }
}

function successorKept(runtime: StoredSessionRecord, to: number): boolean {
  return runtime.info.conversation === to && !(isDormant(runtime) && runtime.sdkSessionId === undefined)
}

// Ready once the engine named a conversation the gateway saved (a first message went out), or left `starting` when
// there is nothing to resume yet; failed when it fails or closes first.
function startupOf(ctx: ServerContext, runner: Runner, wantsIdentity: boolean): Promise<Startup> {
  return new Promise((resolve) => {
    let reason: string | undefined
    let done = false
    let unsubscribe: (() => void) | undefined
    const finish = (startup: Startup): void => {
      done = true
      unsubscribe?.()
      if (startup.kind === 'failed') {
        resolve(startup)
        return
      }
      void ctx.parking.flush(runner.id).then(() => resolve(startup))
    }
    const check = (): void => {
      if (done) {
        return
      }
      const info = runner.info()
      if (info.status === 'failed' || info.status === 'closed') {
        finish({ kind: 'failed', error: reason ?? 'the new conversation stopped while starting' })
        return
      }
      const resumable = (info.capabilities ?? ENGINE_CAPABILITIES[engineOf(info)]).resume
      if (!(wantsIdentity && resumable ? info.sdkSessionId === undefined : info.status === 'starting')) {
        finish({ kind: 'ready' })
      }
    }
    unsubscribe = runner.subscribe((event) => {
      if (event.type === 'session_error') {
        reason = event.message
      }
      check()
    })
    if (done) {
      unsubscribe()
    }
    check()
  })
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
