import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { errorMessage, isJobRun, type ConversationTarget, type SessionInfo } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'
import {
  freshRecord,
  requestedConfig,
  type ConversationEntry,
  type FrozenAuth,
  type SessionCut,
  type SessionRecord,
} from './session-records.ts'
import { durableConfig, isArchived, isDormant, type DormantSessionRecord } from './session-store.ts'

export type CutReason = 'user' | 'clear' | 'context_reset'

export type CutRequest = { expectedGeneration: number; prompt?: string; reason: CutReason; target?: ConversationTarget }

export type CutResult = { session: SessionInfo; conversation: number }

// A socket attached to one conversation: detached quietly at the stop, told and closed once the commit is durable.
export type CutSocket = { detach: () => void; announce: (conversation: number, epoch: number) => void; drop: () => void }

export type EndedExecution = { id: string; n: number; auth: FrozenAuth }

export type CutFault = 'commit' | 'start' | 'after-stop' | 'after-commit'

export const CONVERSATION_ENDED = 'this conversation has ended; reattach to the current one'
export const JOB_CUT_REFUSAL = 'a job run cannot start a new conversation'
export const AGENT_CUT_REFUSAL = 'an agent starts a new conversation through its own rotation'

export class ConversationCuts {
  #context: ServerContext | undefined
  #sockets = new Map<string, Set<CutSocket>>()
  #ended = new Map<string, EndedExecution>()
  #queued = new Map<string, () => void>()
  #failedStarts = new Set<string>()
  // Test seam: a step named here throws, standing in for a crash or a refused write at that boundary.
  readonly faults = new Set<CutFault>()

  bind(ctx: ServerContext): void {
    this.#context = ctx
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

  cut(id: string, request: CutRequest): Promise<CutResult> {
    return this.#ctx.handovers.run([id], () => this.#cut(id, request))
  }

  // The one rule for every door that asks while a turn runs: the cut waits for the next idle.
  clearOnIdle(runner: Runner, reason: CutReason, prompt?: string): Promise<CutResult> | undefined {
    const ctx = this.#ctx
    if (isJobRun(runner.info())) {
      fail(409, JOB_CUT_REFUSAL)
    }
    if (runner.info().status === 'idle') {
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
      if (event.type === 'status_changed' && event.status === 'idle') {
        this.#queued.delete(runner.id)
        unsubscribe()
        const expectedGeneration = ctx.records.conversationOf(runner.id) ?? 1
        this.cut(runner.id, { expectedGeneration, reason, ...(prompt ? { prompt } : {}) }).catch((error: unknown) =>
          ctx.handovers.onError(error),
        )
      }
      if (event.type === 'session_closed') {
        this.#queued.delete(runner.id)
        unsubscribe()
      }
    }, runner.info().lastSeq)
    this.#queued.set(runner.id, unsubscribe)
  }

  async #cut(id: string, request: CutRequest): Promise<CutResult> {
    const ctx = this.#ctx
    const record = await ctx.records.get(id)
    if (record?.closedAt !== undefined) {
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
    if (!info || (stored && isArchived(stored))) {
      fail(404, 'session not found')
    }
    if (isJobRun(info)) {
      fail(409, JOB_CUT_REFUSAL)
    }
    if (ctx.agents.bySession(id)) {
      fail(409, AGENT_CUT_REFUSAL)
    }
    if (live && info.status !== 'idle') {
      fail(409, 'the session is busy; start a new conversation once it is idle')
    }
    if (stored && !isDormant(stored)) {
      fail(409, 'the session is parked mid-turn')
    }
    const target = this.#target(record?.requested ?? record?.running ?? stored?.config ?? ctx.parking.configOf(id), request.target)

    ctx.handovers.gate(id)
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
      ctx.handovers.ungate(id)
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
        await ctx.handovers.run([record.id], async () => {
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
  retryStart(id: string): Promise<CutResult> {
    const ctx = this.#ctx
    return ctx.handovers.run([id], async () => {
      const record = await ctx.records.get(id)
      if (!record?.startFailed || record.cut?.phase !== 'committed') {
        fail(409, 'no new conversation is waiting to start')
      }
      this.#failedStarts.delete(id)
      return await this.#startCommitted(record)
    })
  }

  settlePendingPrompt(id: string, send: boolean): Promise<void> {
    const ctx = this.#ctx
    return ctx.handovers.run([id], async () => {
      const record = await ctx.records.get(id)
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
  close(id: string): Promise<void> {
    const ctx = this.#ctx
    return ctx.handovers.run([id], async () => {
      await ctx.parking.fence(id)
      try {
        const record = await ctx.records.get(id)
        if (record?.closedAt !== undefined) {
          return
        }
        const entry = await this.#capture(id, record, record?.conversation ?? 1).catch(() => undefined)
        if (!entry) {
          return
        }
        await ctx.records.transactDurable(id, (current) => {
          const { runtime: _runtime, cut: _cut, pendingPrompt: _prompt, startFailed: _failed, ...rest } = current ?? freshRecord(id)
          return { ...rest, conversations: [...rest.conversations, entry], closedAt: Date.now() }
        })
        this.#remember(id, entry)
      } finally {
        ctx.parking.unfence(id)
      }
    })
  }

  #commit(current: SessionRecord, entry: ConversationEntry, cut: SessionCut, request: CutRequest, info: SessionInfo): SessionRecord {
    const next = cut.to
    return {
      ...current,
      conversation: next,
      conversations: [...current.conversations, entry],
      running: cut.target,
      ...(request.target ? { requested: cut.target } : {}),
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
    const archive = await ctx.parking.archiveOf(id, {})
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

  async #startCommitted(record: SessionRecord): Promise<CutResult> {
    const ctx = this.#ctx
    const id = record.id
    const cut = record.cut!
    let runner: Runner
    try {
      this.#fault('start')
      runner = await this.#startFresh(id, cut)
    } catch (error) {
      this.#failedStarts.add(id)
      await ctx.records.transactDurable(id, (current) => ({ ...current!, startFailed: { n: cut.to, error: errorMessage(error) } }))
      this.#announce(id, record.conversation, cut.epoch)
      fail(502, `the new conversation did not start: ${errorMessage(error)}`)
    }
    this.#failedStarts.delete(id)
    const started = await ctx.records.transactDurable(id, (current) => {
      const { cut: _done, startFailed: _failed, ...rest } = current!
      const prompt = rest.pendingPrompt
      return prompt?.state === 'pending' ? { ...rest, pendingPrompt: { ...prompt, state: 'sending' } } : rest
    })
    if (started.pendingPrompt?.state === 'sending') {
      if (started.pendingPrompt.n === started.conversation) {
        runner.sendMessage(started.pendingPrompt.text)
      }
      await ctx.records.transactDurable(id, (current) => withoutPendingPrompt(current!))
    }
    this.#announce(id, started.conversation, cut.epoch)
    return { session: ctx.projects.withProject(runner.info()), conversation: started.conversation }
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
  async #startFresh(id: string, cut: SessionCut): Promise<Runner> {
    const ctx = this.#ctx
    const built = ctx.factory.buildRunnerConfig({ ...cut.target, prompt: undefined, resume: undefined, forkSession: undefined })
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
      this.#ended.set(executionId, { id, n: entry.n, auth: entry.auth })
    }
  }

  #fault(step: CutFault): void {
    if (this.faults.has(step)) {
      throw new Error(`injected fault at ${step}`)
    }
  }
}

function withoutPendingPrompt(record: SessionRecord): SessionRecord {
  const { pendingPrompt: _gone, ...rest } = record
  return rest
}
