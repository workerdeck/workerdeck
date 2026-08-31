import type { CreateJobRequest, JobInfo } from '@workerdeck/protocol'

export type JobRecord = {
  info: JobInfo
  request: CreateJobRequest
}

export interface QueueAdapter {
  add(job: JobRecord): Promise<void>
  claimNext(): Promise<JobRecord | null>
  get(id: string): Promise<JobRecord | null>
  list(): Promise<JobRecord[]>
  update(id: string, patch: Partial<JobInfo>): Promise<JobRecord | null>
  prune(olderThanMs: number): Promise<number>
  addDailyTokens(dayKey: string, tokens: number): Promise<number>
  dailyTokens(dayKey: string): Promise<number>
  onWork?(listener: () => void): () => void
}

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
