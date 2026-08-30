import { randomUUID } from 'node:crypto'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import type {
  ApiMessage,
  CreateJobRequest,
  CreateSessionRequest,
  JobEvent,
  JobInfo,
  JobProgress,
  QueueStats,
  SessionEvent,
} from '@workerdeck/protocol'
import { InMemoryQueueAdapter, type JobRecord, type QueueAdapter } from './adapter.ts'

export type JobQueueOptions = {
  /** Turn a session config into a live runner — typically the server registry's create(),
   * so job sessions are ordinary sessions clients can attach to and watch. May be
   * async: engines whose assembly awaits (a provider session's MCP connect) resolve
   * here, and a rejection fails the job like any other start error. */
  createRunner: (config: SessionRunnerConfig) => Runner | Promise<Runner>
  /** Storage/claiming backend. Defaults to the in-memory adapter (single process). */
  adapter?: QueueAdapter
  /** Concurrent job sessions. Default 1. */
  maxConcurrency?: number
  /** Token cap per job session; exceeding it interrupts the run and fails the job. */
  sessionTokenLimit?: number
  /** Global token budget per UTC day; when exhausted, queued jobs are held until the
   * day rolls over (running jobs finish and are accounted). */
  dailyTokenLimit?: number
  /** Wall-clock cap per job run; exceeding it interrupts the run and fails the job.
   * The watchdog for stuck CLIs — without it, a run that never yields a result keeps
   * its job (and concurrency slot) forever. Time spent parked on a deferred
   * execution does not count against it: the run isn't stuck, it's waiting. */
  maxJobDurationMs?: number
  /** Cap on time parked on a deferred execution, across all parks of one run.
   * Exceeding it fails the job (the execution's own watchdog, when the backend set
   * one, usually fires first and lets the agent adapt instead). Unset = unbounded. */
  maxParkedDurationMs?: number
  /** How long a killed run (token/duration limit) may wind down after interrupt()
   * before the queue force-finalizes it and closes the session. Default 5000. */
  killGraceMs?: number
  /** Expire terminal jobs: prune those finished more than `maxAgeMs` ago, sweeping
   * every `sweepIntervalMs` (default min(maxAgeMs, 60s)) and after each completion.
   * Unset = keep forever (the in-memory adapter then grows unboundedly). */
  retention?: { maxAgeMs: number; sweepIntervalMs?: number }
  /** Patch job session configs (inject queryFn, env, tool policy) before they run. */
  buildRunnerConfig?: (req: CreateSessionRequest) => SessionRunnerConfig
  /**
   * Drop a parked session's persisted state: the run ended (cancel, kill, retry)
   * while parked, so nothing will ever rehydrate it. The host that parks sessions
   * — {@link JobQueue.onSessionParking}'s caller — wires this to its session store.
   */
  discardSession?: (sessionId: string) => void | Promise<void>
  /** Webhook transport. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Webhook delivery attempts per event (exponential backoff). Default 3. */
  webhookAttempts?: number
  /** Initial backoff between webhook attempts. Default 500ms. */
  webhookRetryDelayMs?: number
  /** Local observer invoked for every job event (in addition to any webhook). */
  onEvent?: (event: JobEvent) => void
}

type RunningJob = {
  record: JobRecord
  /** Rebuilt on every resume: a rehydrated session is a NEW runner object under
   * the same session id, so nothing may hold the old reference. */
  runner: Runner
  unsubscribe: () => void
  /** Highest event seq seen. A resumed run re-subscribes from here, so the parked
   * session's replayed log doesn't re-deliver a turn the queue already acted on. */
  lastSeq: number
  /** Mid-run token estimate from assistant-message usage (enforcement + progress). */
  estimatedTokens: number
  /** Set when the queue killed the run (limits, cancel) — decides the terminal status. */
  killReason?: string
  canceled: boolean
  finalized: boolean
  /** Per-job webhook chain so deliveries stay ordered. */
  deliveries: Promise<void>
  /** Watchdog: fires killReason when the run exceeds its wall-clock cap. */
  durationTimer?: ReturnType<typeof setTimeout>
  /** Backstop after a kill: force-finalizes if interrupt() never yields a result. */
  forceTimer?: ReturnType<typeof setTimeout>
  /** Wall-clock actually spent running (parked stretches excluded), plus when the
   * current running leg started. Together they bound the duration watchdog across
   * any number of parks. */
  runningMs: number
  legStartedAt: number
  /** Set while parked: when it parked and what it waits on. */
  parkedAt?: number
  parkedExecutionId?: string
  /** Watchdog on total parked time (maxParkedDurationMs). */
  parkTimer?: ReturnType<typeof setTimeout>
  parkedMs: number
}

const dayKey = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10)

const sumUsage = (usage: unknown): number => {
  if (typeof usage !== 'object' || usage === null) {
    return 0
  }
  const u = usage as Record<string, unknown>
  return (
    (typeof u.input_tokens === 'number' ? u.input_tokens : 0) +
    (typeof u.output_tokens === 'number' ? u.output_tokens : 0) +
    (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) +
    (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0)
  )
}

const textPreview = (message: ApiMessage, max = 140): JobProgress | null => {
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      return { kind: 'tool_use', preview: (block as { name?: string }).name }
    }
    if (block.type === 'text') {
      const text = (block as { text?: string }).text ?? ''
      if (text.trim()) {
        return {
          kind: 'assistant_text',
          preview: text.length > max ? text.slice(0, max - 1) + '…' : text,
        }
      }
    }
  }
  return null
}

/**
 * One-shot job execution over the session runner: submitted jobs run `session.prompt`
 * unattended, bounded by `maxConcurrency` and token budgets, and report progress and
 * completion through webhooks (plus `onEvent` locally). Job state lives in the
 * {@link QueueAdapter}; this class owns scheduling and the live runs.
 */
export class JobQueue {
  #options: JobQueueOptions
  #adapter: QueueAdapter
  #running = new Map<string, RunningJob>()
  /** Runs waiting on a deferred execution: alive, but holding no concurrency slot
   * and no live runner. Keyed by job id like `#running`. */
  #parked = new Map<string, RunningJob>()
  #pumping = false
  #closed = false
  #offWork: (() => void) | undefined
  #sweepTimer: ReturnType<typeof setInterval> | undefined
  /** Pending retry-backoff wakeups, cleared on close(). */
  #retryTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(options: JobQueueOptions) {
    this.#options = options
    this.#adapter = options.adapter ?? new InMemoryQueueAdapter()
    this.#offWork = this.#adapter.onWork?.(() => void this.#pump())
    const retention = options.retention
    if (retention) {
      const interval = retention.sweepIntervalMs ?? Math.min(retention.maxAgeMs, 60_000)
      this.#sweepTimer = setInterval(() => this.#sweep(), interval)
      this.#sweepTimer.unref?.()
    }
  }

  async submit(request: CreateJobRequest): Promise<JobInfo> {
    if (this.#closed) {
      throw new Error('queue is closed')
    }
    if (!request.session?.prompt?.trim()) {
      throw new Error('session.prompt is required')
    }
    // No `cwd` check: whether one is required depends on the engine's
    // capability record, which the gateway resolves at the door (see the
    // server's `checkCwd`). A second, engine-blind copy of the rule here would
    // refuse the filesystem-less engine outright.
    if (request.session.resume || request.session.forkSession) {
      throw new Error('resume/forkSession are not supported for queued jobs')
    }
    const attempts = request.attempts ?? 1
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new Error('attempts must be a positive integer')
    }
    if (request.retryDelayMs !== undefined && !(request.retryDelayMs >= 0)) {
      throw new Error('retryDelayMs must be >= 0')
    }
    const info: JobInfo = {
      id: randomUUID(),
      status: 'queued',
      cwd: request.session.cwd ?? '',
      profile: request.session.profile,
      prompt: request.session.prompt,
      createdAt: Date.now(),
      attempt: 1,
      maxAttempts: attempts,
      usage: { tokens: 0, totalCostUsd: 0, numTurns: 0 },
      meta: request.meta,
      // Copied so the job routes gate on the same rule as the session routes; the
      // run's session inherits it at claim time via `record.request.session`.
      scope: request.session.scope,
    }
    const record: JobRecord = { info, request }
    await this.#adapter.add(record)
    this.#emit(record, { type: 'job_submitted', job: info, ts: Date.now() }, undefined, {
      skipWebhook: true,
    })
    void this.#pump()
    return info
  }

  async get(id: string): Promise<JobInfo | null> {
    return (await this.#adapter.get(id))?.info ?? null
  }

  async list(): Promise<JobInfo[]> {
    return (await this.#adapter.list()).map((j) => j.info)
  }

  /**
   * A run's session is about to be parked on a deferred execution: the host has
   * snapshotted it and is tearing the live runner down. The queue drops its
   * subscription to the doomed runner, frees the concurrency slot, and stops the
   * duration clock.
   *
   * Returns false when the queue refuses the park — the run is already finalizing
   * or has been killed, so the host must leave the session alone. A session that
   * belongs to no job accepts trivially (there is nothing to account for).
   */
  onSessionParking(sessionId: string, executionId: string): boolean {
    const job = this.#bySession(this.#running, sessionId)
    if (!job) {
      return true
    }
    if (job.finalized || job.killReason) {
      return false
    }
    const now = Date.now()
    job.unsubscribe()
    job.runningMs += now - job.legStartedAt
    clearTimeout(job.durationTimer)
    job.durationTimer = undefined
    job.parkedAt = now
    job.parkedExecutionId = executionId
    this.#running.delete(job.record.info.id)
    this.#parked.set(job.record.info.id, job)
    const parkedLimit = this.#options.maxParkedDurationMs
    if (parkedLimit !== undefined) {
      job.parkTimer = setTimeout(
        () => this.#kill(job, `job exceeded max parked duration (${parkedLimit}ms)`),
        Math.max(0, parkedLimit - job.parkedMs),
      )
      job.parkTimer.unref?.()
    }
    void this.#recordPark(job, executionId)
    return true
  }

  async #recordPark(job: RunningJob, executionId: string): Promise<void> {
    const updated = await this.#adapter.update(job.record.info.id, {
      status: 'parked',
      parkedAt: job.parkedAt,
      parkedExecutionId: executionId,
    })
    if (updated) {
      job.record = updated
    }
    this.#emit(job.record, { type: 'job_parked', job: job.record.info, executionId, ts: Date.now() }, job)
    // The slot is free now — let a queued job take it.
    void this.#pump()
  }

  /**
   * The parked session was rehydrated (same session id, new runner object) because
   * its execution's result arrived. Re-subscribe and restart the clock with the
   * budget the run had left.
   *
   * A resume takes its slot back immediately, so a burst of resumes can transiently
   * exceed `maxConcurrency` — the alternative would be holding a result the agent
   * loop has already been handed.
   */
  onSessionResumed(sessionId: string, runner: Runner): void {
    const job = this.#bySession(this.#parked, sessionId)
    if (!job || job.finalized) {
      return
    }
    const now = Date.now()
    const executionId = job.parkedExecutionId ?? ''
    clearTimeout(job.parkTimer)
    job.parkTimer = undefined
    job.parkedMs += now - (job.parkedAt ?? now)
    job.parkedAt = undefined
    job.parkedExecutionId = undefined
    job.legStartedAt = now
    job.runner = runner
    this.#parked.delete(job.record.info.id)
    this.#running.set(job.record.info.id, job)
    const durationLimit = this.#effectiveDurationLimit(job.record.request)
    if (durationLimit !== undefined) {
      job.durationTimer = setTimeout(
        () => this.#kill(job, `job exceeded max duration (${durationLimit}ms)`),
        Math.max(0, durationLimit - job.runningMs),
      )
      job.durationTimer.unref?.()
    }
    // From lastSeq, not 0: the rehydrated runner replays the whole persisted log,
    // and re-handling those events would double-count tokens and could re-finalize
    // the job on an old turn_result.
    job.unsubscribe = runner.subscribe((event) => void this.#handleEvent(job, event), job.lastSeq)
    void this.#recordResume(job, executionId)
  }

  async #recordResume(job: RunningJob, executionId: string): Promise<void> {
    const updated = await this.#adapter.update(job.record.info.id, {
      status: 'running',
      parkedAt: undefined,
      parkedExecutionId: undefined,
    })
    if (updated) {
      job.record = updated
    }
    this.#emit(job.record, { type: 'job_resumed', job: job.record.info, executionId, ts: Date.now() }, job)
  }

  #bySession(jobs: Map<string, RunningJob>, sessionId: string): RunningJob | undefined {
    for (const job of jobs.values()) {
      if (job.record.info.sessionId === sessionId) {
        return job
      }
    }
    return undefined
  }

  /** Cancel a queued, running, or parked job. Returns the job, or null if unknown. */
  async cancel(id: string): Promise<JobInfo | null> {
    const record = await this.#adapter.get(id)
    if (!record) {
      return null
    }
    const running = this.#running.get(id) ?? this.#parked.get(id)
    if (running) {
      running.canceled = true
      running.killReason = 'canceled'
      await this.#finalize(running, {
        usage: { tokens: running.estimatedTokens, totalCostUsd: 0, numTurns: 0 },
        status: 'canceled',
        error: 'canceled',
      })
      return running.record.info
    }
    if (record.info.status !== 'queued') {
      return record.info
    }
    const updated = await this.#adapter.update(id, {
      status: 'canceled',
      finishedAt: Date.now(),
      error: 'canceled',
    })
    if (updated) {
      this.#emit(updated, { type: 'job_completed', job: updated.info, ts: Date.now() })
    }
    return updated?.info ?? null
  }

  async stats(): Promise<QueueStats> {
    const jobs = await this.#adapter.list()
    const dailyTokensUsed = await this.#adapter.dailyTokens(dayKey(Date.now()))
    const dailyTokenLimit = this.#options.dailyTokenLimit
    return {
      maxConcurrency: this.#options.maxConcurrency ?? 1,
      running: this.#running.size,
      parked: this.#parked.size,
      queued: jobs.filter((j) => j.info.status === 'queued').length,
      sessionTokenLimit: this.#options.sessionTokenLimit,
      dailyTokenLimit,
      dailyTokensUsed,
      paused: dailyTokenLimit !== undefined && dailyTokensUsed >= dailyTokenLimit,
    }
  }

  /** Stop scheduling new jobs. Running jobs keep finalizing (e.g. when the host closes
   * their sessions); job state stays in the adapter. */
  close(): void {
    this.#closed = true
    this.#offWork?.()
    clearInterval(this.#sweepTimer)
    for (const timer of this.#retryTimers) {
      clearTimeout(timer)
    }
    this.#retryTimers.clear()
  }

  #sweep(): void {
    const retention = this.#options.retention
    if (!retention) {
      return
    }
    this.#adapter.prune(retention.maxAgeMs).catch(() => {
      // sweep failures must not break the queue; the next sweep retries
    })
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#closed) {
      return
    }
    this.#pumping = true
    try {
      const maxConcurrency = this.#options.maxConcurrency ?? 1
      while (this.#running.size < maxConcurrency) {
        const limit = this.#options.dailyTokenLimit
        if (limit !== undefined && (await this.#adapter.dailyTokens(dayKey(Date.now()))) >= limit) {
          return
        }
        const record = await this.#adapter.claimNext()
        if (!record) {
          return
        }
        await this.#start(record)
      }
    } finally {
      this.#pumping = false
    }
  }

  async #start(record: JobRecord): Promise<void> {
    const id = record.info.id
    const build = this.#options.buildRunnerConfig ?? ((req: CreateSessionRequest) => req)
    let runner: Runner
    try {
      // A job run is an ordinary registry session — attachable, listable,
      // indistinguishable — so `meta.jobId` is how a client with its own jobs
      // surface knows not to show it twice (`isJobRun` spells the key).
      const request: CreateSessionRequest = {
        ...record.request.session,
        meta: { ...record.request.session.meta, jobId: id },
      }
      runner = await this.#options.createRunner(build(request))
    } catch (error) {
      const failed = await this.#adapter.update(id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })
      if (failed) {
        this.#emit(failed, { type: 'job_completed', job: failed.info, ts: Date.now() })
      }
      return
    }
    const job: RunningJob = {
      record,
      runner,
      unsubscribe: () => {},
      lastSeq: 0,
      estimatedTokens: 0,
      canceled: false,
      finalized: false,
      deliveries: Promise.resolve(),
      runningMs: 0,
      legStartedAt: Date.now(),
      parkedMs: 0,
    }
    this.#running.set(id, job)
    const updated = await this.#adapter.update(id, {
      startedAt: Date.now(),
      sessionId: runner.id,
    })
    if (updated) {
      job.record = updated
    }
    this.#emit(job.record, { type: 'job_started', job: job.record.info, ts: Date.now() })
    const durationLimit = this.#effectiveDurationLimit(record.request)
    if (durationLimit !== undefined) {
      job.durationTimer = setTimeout(() => this.#kill(job, `job exceeded max duration (${durationLimit}ms)`), durationLimit)
      job.durationTimer.unref?.()
    }
    job.unsubscribe = runner.subscribe((event) => void this.#handleEvent(job, event))
  }

  /** Kill a run: interrupt it and, if the CLI never yields a result (stuck process),
   * force-finalize after the grace period so the job can't hang forever. */
  #kill(job: RunningJob, reason: string): void {
    if (job.finalized || job.killReason) {
      return
    }
    job.killReason = reason
    if (job.parkedAt !== undefined) {
      // Parked: there is no live runner to interrupt and no result coming, so the
      // grace period would just be dead time.
      void this.#finalize(job, {
        usage: { tokens: job.estimatedTokens, totalCostUsd: 0, numTurns: 0 },
        status: job.canceled ? 'canceled' : 'failed',
        error: reason,
      })
      return
    }
    void job.runner.interrupt().catch(() => {})
    job.forceTimer = setTimeout(() => {
      void this.#finalize(job, {
        usage: { tokens: job.estimatedTokens, totalCostUsd: 0, numTurns: 0 },
        status: job.canceled ? 'canceled' : 'failed',
        error: reason,
      })
    }, this.#options.killGraceMs ?? 5000)
    job.forceTimer.unref?.()
  }

  async #handleEvent(job: RunningJob, event: SessionEvent): Promise<void> {
    if (job.finalized) {
      return
    }
    job.lastSeq = Math.max(job.lastSeq, event.seq)
    switch (event.type) {
      case 'system_init':
        await this.#adapter.update(job.record.info.id, { sdkSessionId: event.sdkSessionId })
        return
      case 'assistant_message': {
        if (event.replay) {
          return
        }
        job.estimatedTokens += sumUsage(event.message.usage)
        const limit = this.#effectiveTokenLimit(job.record.request)
        if (limit !== undefined && job.estimatedTokens > limit) {
          this.#kill(job, `session token limit exceeded (${job.estimatedTokens} > ${limit})`)
        }
        const progress = textPreview(event.message)
        if (progress) {
          this.#progress(job, progress)
        }
        return
      }
      case 'permission_requested':
        // The full request rides along so webhook consumers can answer it over REST
        // (questions, approvals) instead of only seeing a preview string.
        this.#progress(job, {
          kind: 'permission_requested',
          preview: event.request.title ?? event.request.toolName,
          request: event.request,
        })
        return
      case 'permission_resolved':
        this.#progress(job, { kind: 'permission_resolved', preview: event.behavior })
        return
      case 'turn_result': {
        // One job = one unattended run: the first result is the outcome.
        const tokens = sumUsage(event.usage) || job.estimatedTokens
        await this.#finalize(job, {
          usage: {
            tokens,
            totalCostUsd: event.totalCostUsd,
            numTurns: event.numTurns,
          },
          result: {
            subtype: event.subtype,
            isError: event.isError,
            result: event.result,
            errors: event.errors,
            durationMs: event.durationMs,
          },
          status: job.killReason ? (job.canceled ? 'canceled' : 'failed') : event.isError ? 'failed' : 'succeeded',
          error: job.killReason ?? (event.isError ? event.errors?.join('; ') || event.subtype : undefined),
        })
        return
      }
      case 'session_error':
        await this.#finalize(job, {
          usage: { tokens: job.estimatedTokens, totalCostUsd: 0, numTurns: 0 },
          status: job.canceled ? 'canceled' : 'failed',
          error: job.killReason ?? event.message,
        })
        return
      case 'session_closed':
        await this.#finalize(job, {
          usage: { tokens: job.estimatedTokens, totalCostUsd: 0, numTurns: 0 },
          status: job.canceled ? 'canceled' : 'failed',
          error: job.killReason ?? 'session closed before completing',
        })
        return
      default:
        return
    }
  }

  #effectiveTokenLimit(request: CreateJobRequest): number | undefined {
    const limits = [request.maxTokens, this.#options.sessionTokenLimit].filter((n): n is number => typeof n === 'number')
    return limits.length > 0 ? Math.min(...limits) : undefined
  }

  #effectiveDurationLimit(request: CreateJobRequest): number | undefined {
    const limits = [request.maxDurationMs, this.#options.maxJobDurationMs].filter((n): n is number => typeof n === 'number')
    return limits.length > 0 ? Math.min(...limits) : undefined
  }

  /** End the current run. `patch.usage` is this attempt's usage alone — prior attempts'
   * totals live on the stored info and are folded in here. A failed (not canceled) run
   * with attempts left re-queues with backoff instead of completing. */
  async #finalize(job: RunningJob, patch: Partial<JobInfo>): Promise<void> {
    if (job.finalized) {
      return
    }
    job.finalized = true
    job.unsubscribe()
    clearTimeout(job.durationTimer)
    clearTimeout(job.forceTimer)
    clearTimeout(job.parkTimer)
    this.#running.delete(job.record.info.id)
    const wasParked = this.#parked.delete(job.record.info.id)
    job.runner.close('server')
    if (wasParked && job.record.info.sessionId) {
      // The live runner is already gone; what survives the run is the persisted
      // snapshot, and nothing will ever rehydrate it now.
      try {
        void Promise.resolve(this.#options.discardSession?.(job.record.info.sessionId)).catch(() => {})
      } catch {
        // discard failures must not break finalization
      }
    }
    const attemptUsage = patch.usage ?? { tokens: 0, totalCostUsd: 0, numTurns: 0 }
    if (attemptUsage.tokens > 0) {
      await this.#adapter.addDailyTokens(dayKey(Date.now()), attemptUsage.tokens)
    }
    const prior = job.record.info.usage
    const usage = {
      tokens: prior.tokens + attemptUsage.tokens,
      totalCostUsd: prior.totalCostUsd + attemptUsage.totalCostUsd,
      numTurns: prior.numTurns + attemptUsage.numTurns,
    }
    const attempt = job.record.info.attempt ?? 1
    const maxAttempts = job.record.request.attempts ?? 1
    if (patch.status === 'failed' && attempt < maxAttempts && !this.#closed) {
      const baseDelay = job.record.request.retryDelayMs ?? 5000
      const delay = baseDelay * 2 ** (attempt - 1)
      const updated = await this.#adapter.update(job.record.info.id, {
        status: 'queued',
        attempt: attempt + 1,
        nextRunAt: Date.now() + delay,
        error: patch.error,
        usage,
        sessionId: undefined,
        sdkSessionId: undefined,
        startedAt: undefined,
        result: undefined,
      })
      if (updated) {
        job.record = updated
        this.#emit(updated, { type: 'job_retrying', job: updated.info, ts: Date.now() }, job)
        const timer = setTimeout(() => {
          this.#retryTimers.delete(timer)
          void this.#pump()
        }, delay)
        timer.unref?.()
        this.#retryTimers.add(timer)
      }
      void this.#pump()
      return
    }
    const updated = await this.#adapter.update(job.record.info.id, {
      ...patch,
      usage,
      nextRunAt: undefined,
      finishedAt: Date.now(),
    })
    if (updated) {
      job.record = updated
      // Pass the job so the completion webhook stays ordered behind its progress
      // deliveries (the running-map entry is already gone).
      this.#emit(job.record, { type: 'job_completed', job: updated.info, ts: Date.now() }, job)
    }
    this.#sweep()
    void this.#pump()
  }

  #progress(job: RunningJob, progress: JobProgress): void {
    const event: JobEvent = { type: 'job_progress', job: job.record.info, progress, ts: Date.now() }
    // 'completion' granularity: local observers still see progress; the webhook doesn't.
    if (job.record.request.webhook?.progress === 'completion') {
      try {
        this.#options.onEvent?.(event)
      } catch {
        // observer errors must not break the queue
      }
      return
    }
    this.#emit(job.record, event, job)
  }

  /** Notify the local observer and, when configured, the job's webhook (ordered per job). */
  #emit(record: JobRecord, event: JobEvent, chainOwner?: RunningJob, { skipWebhook = false }: { skipWebhook?: boolean } = {}): void {
    try {
      this.#options.onEvent?.(event)
    } catch {
      // observer errors must not break the queue
    }
    const webhook = record.request.webhook
    if (!webhook || skipWebhook) {
      return
    }
    const running = chainOwner ?? this.#running.get(record.info.id)
    const deliver = () => this.#deliver(webhook.url, webhook.headers, event)
    if (running) {
      running.deliveries = running.deliveries.then(deliver)
    } else {
      void deliver()
    }
  }

  async #deliver(url: string, headers: Record<string, string> | undefined, event: JobEvent): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch
    const attempts = this.#options.webhookAttempts ?? 3
    const baseDelay = this.#options.webhookRetryDelayMs ?? 500
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(event),
        })
        if (res.ok) {
          return
        }
      } catch {
        // network error — retry below
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt))
      }
    }
    // Deliveries are best-effort; clients can always poll GET /jobs/:id.
  }
}
