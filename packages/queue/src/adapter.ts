import type { CreateJobRequest, JobInfo } from '@workerdeck/protocol'

/** A job as the adapter stores it: the wire-visible info plus the original request. */
export type JobRecord = {
  info: JobInfo
  request: CreateJobRequest
}

/**
 * Storage + claiming contract the JobQueue runs against; the bundled implementation
 * is {@link InMemoryQueueAdapter}. Everything is Promise-based so remote backends
 * (redis/bullmq/pubsub) fit without changing the queue, and **`claimNext` is the one
 * operation that must be atomic across workers** — two concurrent claims must never
 * return the same job.
 */
export interface QueueAdapter {
  /** Persist a newly submitted job (status 'queued'). */
  add(job: JobRecord): Promise<void>
  /**
   * Atomically claim the oldest claimable queued job, transitioning it to 'running'.
   * A queued job whose `nextRunAt` is in the future (retry backoff) is not claimable
   * yet. Returns null when nothing is claimable.
   */
  claimNext(): Promise<JobRecord | null>
  get(id: string): Promise<JobRecord | null>
  /** All known jobs, oldest first. Backends may cap retention of terminal jobs. */
  list(): Promise<JobRecord[]>
  /** Merge a partial info patch into a job (a key explicitly set to undefined clears
   * that field). Returns the updated record, or null if unknown. */
  update(id: string, patch: Partial<JobInfo>): Promise<JobRecord | null>
  /** Delete terminal jobs (succeeded/failed/canceled) that finished more than
   * `olderThanMs` ago. Returns how many were removed. */
  prune(olderThanMs: number): Promise<number>
  /**
   * Add tokens to a day's global counter and return the new total. `dayKey` is a UTC
   * 'YYYY-MM-DD'; keeping the counter in the adapter makes daily budgets hold across
   * multiple workers sharing a backend.
   */
  addDailyTokens(dayKey: string, tokens: number): Promise<number>
  dailyTokens(dayKey: string): Promise<number>
  /**
   * Optional: notify the queue that work may be available (a job added by another
   * producer on a shared backend). The bundled queue also pumps after its own
   * submits/completions, so purely local adapters can omit this.
   */
  onWork?(listener: () => void): () => void
}

/** Reference adapter: single-process, no persistence. Jobs and daily counters are lost
 * on restart — production deployments should back the queue with a shared store. */
export class InMemoryQueueAdapter implements QueueAdapter {
  #jobs = new Map<string, JobRecord>()
  #dailyTokens = new Map<string, number>()

  add(job: JobRecord): Promise<void> {
    this.#jobs.set(job.info.id, job)
    return Promise.resolve()
  }

  claimNext(): Promise<JobRecord | null> {
    const now = Date.now()
    for (const job of this.#jobs.values()) {
      if (job.info.status === 'queued' && (job.info.nextRunAt === undefined || job.info.nextRunAt <= now)) {
        job.info = { ...job.info, status: 'running' }
        return Promise.resolve(job)
      }
    }
    return Promise.resolve(null)
  }

  get(id: string): Promise<JobRecord | null> {
    return Promise.resolve(this.#jobs.get(id) ?? null)
  }

  list(): Promise<JobRecord[]> {
    return Promise.resolve([...this.#jobs.values()])
  }

  update(id: string, patch: Partial<JobInfo>): Promise<JobRecord | null> {
    const job = this.#jobs.get(id)
    if (!job) {
      return Promise.resolve(null)
    }
    job.info = { ...job.info, ...patch }
    return Promise.resolve(job)
  }

  prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs
    let removed = 0
    for (const [id, job] of this.#jobs) {
      const { status, finishedAt } = job.info
      const terminal = status === 'succeeded' || status === 'failed' || status === 'canceled'
      if (terminal && (finishedAt ?? 0) <= cutoff) {
        this.#jobs.delete(id)
        removed++
      }
    }
    return Promise.resolve(removed)
  }

  addDailyTokens(dayKey: string, tokens: number): Promise<number> {
    const next = (this.#dailyTokens.get(dayKey) ?? 0) + tokens
    this.#dailyTokens.set(dayKey, next)
    return Promise.resolve(next)
  }

  dailyTokens(dayKey: string): Promise<number> {
    return Promise.resolve(this.#dailyTokens.get(dayKey) ?? 0)
  }
}
