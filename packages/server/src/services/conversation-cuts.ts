import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, errorMessage, isJobRun, type ConversationTarget, type SessionInfo } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
import { freshRecord, requestedConfig, type ConversationEntry, type SessionCut, type SessionRecord } from './session-records.ts'
import { durableConfig, isDormant, type DormantSessionRecord, type StoredSessionRecord } from './session-store.ts'

export type CutReason = 'user' | 'clear' | 'context_reset'

export type CutRequest = { expectedGeneration: number; prompt?: string; reason: CutReason; target?: ConversationTarget }

export type CutResult = { session: SessionInfo; conversation: number }

// A socket attached to one conversation: detached quietly at the stop, told and closed once the commit is durable.
export type CutSocket = { detach: () => void; announce: (conversation: number, epoch: number) => void; drop: () => void }

export type EndedExecution = { id: string; entry: ConversationEntry }

export type CutGuard = (record: SessionRecord | null) => Promise<void> | void

export type CutFault = 'commit' | 'start' | 'after-stop' | 'after-commit'

export const CONVERSATION_ENDED = 'this conversation has ended; reattach to the current one'
export const UNANSWERED_REFUSAL = 'the session has a message it has not answered yet; start a new conversation once it has'
export const JOB_CUT_REFUSAL = 'a job run cannot start a new conversation'

export class ConversationCuts {
  #context: ServerContext | undefined
  #sockets = new Map<string, Set<CutSocket>>()
  #ended = new Map<string, EndedExecution>()
  #queued = new Map<string, () => void>()
  #failedStarts = new Set<string>()
  #firstStarts = new Map<string, Promise<void>>()
  #closed = false
  // Test seam: a step named here throws, standing in for a crash or a refused write at that boundary.
  readonly faults = new Set<CutFault>()

  bind(ctx: ServerContext): void {
    this.#context = ctx
  }

  // The generation is ending: a start still settling in the background is left as its intent for the next one to recover,
  // never failed because shutdown closed its runner.
  close(): void {
    this.#closed = true
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

  endedExecution(executionId: string): EndedExecution | undefined {
    return this.#ended.get(executionId)
  }

  // `guard` runs inside the lifecycle lock on the record as it is then: the caller's own check of the current
  // conversation and of its sight of the session, so nothing it decided before the lock can be acted on after it.
  async cut(id: string, request: CutRequest, guard?: CutGuard): Promise<CutResult> {
    await this.#firstStarts.get(id)
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
      const startup = await startupOf(ctx, runner, record.pendingPrompt?.n === 1)
      if (this.#closed) {
        return
      }
      await ctx.locks.run([id], () => this.#settle(id, 1, false, runner, startup, false))
    })()
      .catch((error: unknown) => ctx.locks.onError(error))
      .finally(() => {
        if (this.#firstStarts.get(id) === settled) {
          this.#firstStarts.delete(id)
        }
      })
    this.#firstStarts.set(id, settled)
  }

  // The one rule for every door that asks while a turn runs: the cut waits for the next idle.
  clearOnIdle(runner: Runner, reason: CutReason, prompt?: string): Promise<CutResult> | undefined {
    const ctx = this.#ctx
    if (isJobRun(runner.info())) {
      fail(409, JOB_CUT_REFUSAL)
    }
    if (runner.info().status === 'idle' && !unanswered(runner)) {
      return this.cut(runner.id, { expectedGeneration: ctx.records.conversationOf(runner.id) ?? 1, reason, ...(prompt ? { prompt } : {}) })
    }
    this.#queueOnIdle(runner, reason, prompt)
    return undefined
  }

  #queueOnIdle(runner: Runner, reason: CutReason, prompt: string | undefined): void {
    if (this.#queued.has(runner.id)) {
      return
    }
    const ctx = this.#ctx
    const unsubscribe = runner.subscribe((event) => {
      if (event.type === 'status_changed' && event.status === 'idle' && !unanswered(runner)) {
        this.#queued.delete(runner.id)
        unsubscribe()
        const expectedGeneration = ctx.records.conversationOf(runner.id) ?? 1
        this.cut(runner.id, { expectedGeneration, reason, ...(prompt ? { prompt } : {}) }).catch((error: unknown) =>
          ctx.locks.onError(error),
        )
      }
      if (event.type === 'session_closed') {
        this.#queued.delete(runner.id)
        unsubscribe()
      }
    }, runner.info().lastSeq)
    this.#queued.set(runner.id, unsubscribe)
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
    if (live && unanswered(live)) {
      fail(409, UNANSWERED_REFUSAL)
    }
    if (stored && !isDormant(stored)) {
      fail(409, 'the session is parked mid-turn')
    }
    const target = this.#target(record?.requested ?? record?.running ?? stored?.config ?? ctx.parking.configOf(id), request.target)

    ctx.locks.gate(id)
    try {
      await ctx.parking.fence(id)
      const entry = await this.#capture(id, record, conversation)
      const cut: SessionCut = { from: conversation, to: conversation + 1, phase: 'prepared', epoch: (info.epoch ?? 0) + 1, target }
      await ctx.records.transactDurable(id, (current) => ({ ...(current ?? freshRecord(id)), cut }))

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
        const { runtime: _runtime, cut: _cut, pendingPrompt: _prompt, startFailed: _failed, ...rest } = current ?? freshRecord(id)
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
        ...(info.owner ? { owner: info.owner } : {}),
        ...(target.scope ? { scope: target.scope } : {}),
        ...(target.meta ? { meta: target.meta } : {}),
      },
      ...(target.profile ? { profile: target.profile } : {}),
      config: { ...target, epoch: cut.epoch },
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
    if (!live && record.runtime && successorKept(record.runtime, cut.to)) {
      await this.#confirm(id, cut.to, intent !== undefined)
      this.#announce(id, cut.to, cut.epoch)
      return { session: ctx.projects.withProject(record.runtime.info), conversation: cut.to }
    }
    const prompt = !live && intent?.state === 'pending' ? intent.text : undefined
    const uncertain = intent !== undefined && prompt === undefined
    let runner = live
    if (!runner) {
      if (prompt !== undefined) {
        await ctx.records.transactDurable(id, (current) => ({ ...current!, pendingPrompt: { ...intent!, state: 'sending' } }))
      }
      try {
        this.#fault('start')
        runner = await this.#startFresh(id, cut, prompt)
      } catch (error) {
        await this.#failStart(id, cut.to, errorMessage(error), prompt !== undefined)
        this.#announce(id, cut.to, cut.epoch)
        fail(502, `the new conversation did not start: ${errorMessage(error)}`)
      }
    }
    const started = runner
    const startup = startupOf(ctx, started, prompt !== undefined)
    const early = await within(startup, ctx.locks.startupTimeoutMs)
    if (early) {
      try {
        await this.#settle(id, cut.to, uncertain, started, early, true)
      } finally {
        this.#announce(id, cut.to, cut.epoch)
      }
      return { session: ctx.projects.withProject(started.info()), conversation: cut.to }
    }
    void startup
      .then((late) => (this.#closed ? undefined : ctx.locks.run([id], () => this.#settle(id, cut.to, uncertain, started, late, false))))
      .catch((error: unknown) => ctx.locks.onError(error))
    this.#announce(id, cut.to, cut.epoch)
    return { session: ctx.projects.withProject(started.info()), conversation: cut.to }
  }

  // `strict` answers the caller, so a failure throws; otherwise it settles in the background for nobody.
  async #settle(id: string, to: number, uncertain: boolean, runner: Runner, startup: Startup, strict: boolean): Promise<void> {
    const record = await this.#ctx.records.get(id)
    if (record?.cut?.phase !== 'committed' || record.cut.to !== to || (!strict && record.startFailed !== undefined)) {
      return
    }
    const failure = startup.kind === 'failed' ? startup.error : await this.#durability(id, to, runner)
    if (failure === undefined) {
      await this.#confirm(id, to, uncertain)
      return
    }
    await this.#failStart(id, to, failure, false)
    if (strict) {
      fail(502, `the new conversation did not start: ${failure}`)
    }
  }

  // Read back, never assumed from a flush. An engine with neither resume nor a live snapshot has nothing to keep.
  async #durability(id: string, to: number, runner: Runner): Promise<string | undefined> {
    const ctx = this.#ctx
    const info = runner.info()
    const resumable = (info.capabilities ?? ENGINE_CAPABILITIES[engineOf(info)]).resume
    if (!resumable && !ctx.parking.persistsLive(runner)) {
      return undefined
    }
    if (await this.#recorded(id, to, runner, resumable)) {
      return undefined
    }
    ctx.parking.touch(runner)
    await ctx.parking.flush(id)
    return (await this.#recorded(id, to, runner, resumable)) ? undefined : 'the new conversation could not be saved'
  }

  async #recorded(id: string, to: number, runner: Runner, resumable: boolean): Promise<boolean> {
    const runtime = (await this.#ctx.records.get(id))?.runtime
    if (!runtime || runtime.info.conversation !== to) {
      return false
    }
    if (!resumable) {
      return runtime.kind === 'live'
    }
    const named = runner.info().sdkSessionId
    return !isDormant(runtime) || named === undefined || runtime.sdkSessionId === named
  }

  async #confirm(id: string, to: number, uncertain: boolean): Promise<void> {
    this.#failedStarts.delete(id)
    await this.#ctx.records.transactDurable(id, (current) => {
      const { cut: _done, startFailed: _failed, pendingPrompt, ...rest } = current!
      const lost = uncertain && pendingPrompt?.n === to
      return lost ? { ...rest, pendingPrompt: { ...pendingPrompt, state: 'uncertain' } } : rest
    })
  }

  async #failStart(id: string, to: number, error: string, unsent: boolean): Promise<void> {
    const ctx = this.#ctx
    this.#failedStarts.add(id)
    void ctx.parking.fence(id)
    await ctx.records.transactDurable(id, (current) => {
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

  #announce(id: string, conversation: number, epoch: number): void {
    for (const socket of this.#sockets.get(id) ?? []) {
      socket.announce(conversation, epoch)
    }
    this.#sockets.delete(id)
  }

  // An explicit fresh constructor: no resume, no fork, no restore, the target's own engine home, the committed epoch.
  async #startFresh(id: string, cut: SessionCut, prompt: string | undefined): Promise<Runner> {
    const ctx = this.#ctx
    const built = ctx.factory.buildRunnerConfig({ ...cut.target, prompt, resume: undefined, forkSession: undefined })
    const config: SessionRunnerConfig = { ...built, epoch: cut.epoch }
    const runner = await ctx.factory.buildRunner(config, undefined, id)
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

  #fault(step: CutFault): void {
    if (this.faults.has(step)) {
      throw new Error(`injected fault at ${step}`)
    }
  }
}

function withoutSnapshot(entry: ConversationEntry): ConversationEntry {
  const { snapshot: _snapshot, ...rest } = entry
  return rest
}

function withoutPendingPrompt(record: SessionRecord): SessionRecord {
  const { pendingPrompt: _gone, ...rest } = record
  return rest
}

type Startup = { kind: 'ready' } | { kind: 'failed'; error: string }

// Input n's engine took and has not consumed (a peer's queued behind a turn, a person's): the cut waits for it to be
// answered in n, so it is never dropped with n's engine and never carried into n+1. The runner's own state decides.
function unanswered(runner: Runner): boolean {
  return (runner.pendingInput?.() ?? 0) > 0
}

// A runtime for n+1 that the engine has named (or a live snapshot): the successor exists and is resumed, not replaced.
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
