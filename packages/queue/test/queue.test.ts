import { describe, expect, it, vi } from 'vitest'
import type { SessionRunner } from '@workerdeck/core'
import type { CreateJobRequest, JobEvent, SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { InMemoryQueueAdapter, JobQueue, type JobQueueOptions } from '../src/index.ts'

class FakeRunner {
  static count = 0
  id = `runner-${++FakeRunner.count}`
  interrupt = vi.fn(async () => {})
  closed = false
  #events: SessionEvent[] = []
  #listeners = new Set<(e: SessionEvent) => void>()
  #seq = 0

  emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: 0 } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  subscribe(listener: (e: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) {
        listener(event)
      }
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.emit({ type: 'session_closed', reason })
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// A deadline, not a latency assertion: every wait here asserts something eventually settles, and vi.waitFor's 1s default
// starved a 1ms retry timer under parallel CI workers — the flake that failed the v0.9.0 publish.
const settles = <T>(assertion: () => T | Promise<T>): Promise<T> => vi.waitFor(assertion, { timeout: 15_000, interval: 10 })

const jobRequest = (overrides: Partial<CreateJobRequest> = {}): CreateJobRequest => ({
  session: { cwd: '/tmp/project', prompt: 'do the thing' },
  ...overrides,
})

const assistantWithUsage = (outputTokens: number, text = 'working on it'): SessionEventBody => ({
  type: 'assistant_message',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: outputTokens },
  },
  parentToolUseId: null,
  uuid: `a-${Math.random()}`,
})

const successResult = (tokens = 100): SessionEventBody => ({
  type: 'turn_result',
  subtype: 'success',
  isError: false,
  durationMs: 900,
  numTurns: 1,
  totalCostUsd: 0.05,
  result: 'all done',
  usage: { input_tokens: tokens / 2, output_tokens: tokens / 2 },
})

const errorResult = (): SessionEventBody => ({
  type: 'turn_result',
  subtype: 'error_max_turns',
  isError: true,
  durationMs: 100,
  numTurns: 3,
  totalCostUsd: 0.2,
  errors: ['hit max turns'],
})

const makeQueue = (options: Partial<JobQueueOptions> = {}) => {
  const runners: FakeRunner[] = []
  const createRunner = vi.fn(() => {
    const runner = new FakeRunner()
    runners.push(runner)
    return runner as unknown as SessionRunner
  })
  const events: JobEvent[] = []
  const queue = new JobQueue({
    createRunner,
    onEvent: (e) => events.push(e),
    ...options,
  })
  return { queue, runners, createRunner, events }
}

describe('JobQueue', () => {
  it('validates submissions', async () => {
    const { queue } = makeQueue()
    await expect(queue.submit({ session: { cwd: '/tmp', prompt: ' ' } })).rejects.toThrow(/prompt/)
    await expect(queue.submit({ session: { cwd: '/tmp', prompt: 'x', resume: 'sdk-1' } })).rejects.toThrow(/resume/)
  })

  it('runs jobs FIFO within maxConcurrency and completes with the run result', async () => {
    const { queue, runners, events } = makeQueue({ maxConcurrency: 1 })
    const a = await queue.submit(jobRequest({ meta: { n: 1 } }))
    const b = await queue.submit(jobRequest({ meta: { n: 2 } }))
    await tick()

    expect(runners).toHaveLength(1)
    expect((await queue.get(b.id))?.status).toBe('queued')
    expect((await queue.get(a.id))?.status).toBe('running')
    expect((await queue.get(a.id))?.sessionId).toBe(runners[0]!.id)

    runners[0]!.emit(assistantWithUsage(20))
    runners[0]!.emit(successResult(100))
    await tick()

    const doneA = await queue.get(a.id)
    expect(doneA).toMatchObject({
      status: 'succeeded',
      usage: { tokens: 100, totalCostUsd: 0.05, numTurns: 1 },
      result: { subtype: 'success', isError: false, result: 'all done' },
    })
    expect(doneA?.finishedAt).toBeDefined()
    expect(runners[0]!.closed).toBe(true)

    await settles(async () => expect((await queue.get(b.id))?.status).toBe('running'))
    expect(runners).toHaveLength(2)

    const types = events.map((e) => `${e.type}:${(e.job.meta as { n?: number })?.n}`)
    expect(types).toContain('job_started:1')
    expect(types).toContain('job_progress:1')
    expect(types).toContain('job_completed:1')
    expect(types).toContain('job_started:2')
  })

  it('runs jobs in parallel up to maxConcurrency', async () => {
    const { queue, runners } = makeQueue({ maxConcurrency: 2 })
    await queue.submit(jobRequest())
    await queue.submit(jobRequest())
    await queue.submit(jobRequest())
    await tick()
    expect(runners).toHaveLength(2)
    expect((await queue.stats()).running).toBe(2)
    expect((await queue.stats()).queued).toBe(1)
  })

  it('maps error results to failed jobs', async () => {
    const { queue, runners } = makeQueue()
    const job = await queue.submit(jobRequest())
    await tick()
    runners[0]!.emit(errorResult())
    await tick()
    expect(await queue.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'hit max turns',
      result: { subtype: 'error_max_turns', isError: true },
    })
  })

  it('fails jobs whose session errors before a result', async () => {
    const { queue, runners } = makeQueue()
    const job = await queue.submit(jobRequest())
    await tick()
    runners[0]!.emit({ type: 'session_error', message: 'spawn failed' })
    await tick()
    expect(await queue.get(job.id)).toMatchObject({ status: 'failed', error: 'spawn failed' })
  })

  it('cancels queued jobs without starting them', async () => {
    const { queue, runners, events } = makeQueue({ maxConcurrency: 1 })
    await queue.submit(jobRequest())
    const waiting = await queue.submit(jobRequest())
    await tick()
    const canceled = await queue.cancel(waiting.id)
    expect(canceled?.status).toBe('canceled')
    expect(runners).toHaveLength(1)
    expect(events.some((e) => e.type === 'job_completed' && e.job.id === waiting.id)).toBe(true)
  })

  it('cancels running jobs by closing their session', async () => {
    const { queue, runners } = makeQueue()
    const job = await queue.submit(jobRequest())
    await tick()
    const canceled = await queue.cancel(job.id)
    expect(canceled?.status).toBe('canceled')
    expect(runners[0]!.closed).toBe(true)
    expect((await queue.stats()).running).toBe(0)
  })

  it('interrupts a run that exceeds its session token limit and fails the job', async () => {
    const { queue, runners } = makeQueue({ sessionTokenLimit: 100 })
    const job = await queue.submit(jobRequest())
    await tick()
    runners[0]!.emit(assistantWithUsage(50))
    expect(runners[0]!.interrupt).not.toHaveBeenCalled()
    runners[0]!.emit(assistantWithUsage(80))
    expect(runners[0]!.interrupt).toHaveBeenCalled()
    runners[0]!.emit({
      type: 'turn_result',
      subtype: 'error_during_execution',
      isError: true,
      durationMs: 100,
      numTurns: 1,
      totalCostUsd: 0.1,
      errors: ['interrupted'],
    })
    await tick()
    expect(await queue.get(job.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('token limit'),
    })
  })

  it('the per-job maxTokens tightens the server limit, never widens it', async () => {
    const { queue, runners } = makeQueue({ sessionTokenLimit: 1000 })
    await queue.submit(jobRequest({ maxTokens: 50 }))
    await tick()
    runners[0]!.emit(assistantWithUsage(60))
    expect(runners[0]!.interrupt).toHaveBeenCalled()
  })

  it('holds queued jobs once the daily token budget is exhausted', async () => {
    const adapter = new InMemoryQueueAdapter()
    const { queue, runners } = makeQueue({ adapter, dailyTokenLimit: 80, maxConcurrency: 1 })
    const first = await queue.submit(jobRequest())
    await tick()
    runners[0]!.emit(successResult(100))
    await tick()
    expect((await queue.get(first.id))?.status).toBe('succeeded')

    const second = await queue.submit(jobRequest())
    await tick()
    expect(runners).toHaveLength(1)
    expect((await queue.get(second.id))?.status).toBe('queued')
    const stats = await queue.stats()
    expect(stats).toMatchObject({ paused: true, dailyTokensUsed: 100, queued: 1, running: 0 })
  })

  it('delivers webhook events in order and retries failed deliveries', async () => {
    const calls: Array<{ url: string; event: JobEvent; auth?: string }> = []
    let failures = 1
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (failures > 0) {
        failures--
        return { ok: false, status: 500 } as Response
      }
      calls.push({
        url: String(url),
        event: JSON.parse(String(init?.body)) as JobEvent,
        auth: (init?.headers as Record<string, string>)?.authorization,
      })
      return { ok: true, status: 200 } as Response
    })
    const { queue, runners } = makeQueue({ fetchImpl, webhookRetryDelayMs: 1 })
    await queue.submit(
      jobRequest({
        webhook: { url: 'https://example.test/hook', headers: { authorization: 'Bearer x' } },
      }),
    )
    await tick()
    runners[0]!.emit(assistantWithUsage(10, 'first I will look around'))
    runners[0]!.emit(successResult())
    await settles(() => {
      expect(calls.map((c) => c.event.type)).toEqual(['job_started', 'job_progress', 'job_completed'])
    })
    expect(calls.every((c) => c.auth === 'Bearer x')).toBe(true)
    expect(calls.every((c) => c.url === 'https://example.test/hook')).toBe(true)
    const progress = calls[1]!.event
    expect(progress.type === 'job_progress' && progress.progress).toMatchObject({
      kind: 'assistant_text',
      preview: 'first I will look around',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('announces submissions to local observers but never to the webhook', async () => {
    const delivered: JobEvent[] = []
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body)) as JobEvent)
      return { ok: true, status: 200 } as Response
    })
    const { queue, runners, events } = makeQueue({ fetchImpl })
    await queue.submit(jobRequest({ webhook: { url: 'https://example.test/hook' } }))
    expect(events.map((e) => e.type)).toContain('job_submitted')
    await tick()
    runners[0]!.emit(successResult())
    await settles(() => {
      expect(delivered.map((e) => e.type)).toEqual(['job_started', 'job_completed'])
    })
  })

  it('validates retry attempts', async () => {
    const { queue } = makeQueue()
    await expect(queue.submit(jobRequest({ attempts: 0 }))).rejects.toThrow(/attempts/)
    await expect(queue.submit(jobRequest({ attempts: 1.5 }))).rejects.toThrow(/attempts/)
  })

  it('re-queues a failed run with backoff, then completes on a later attempt', async () => {
    const { queue, runners, events } = makeQueue()
    const job = await queue.submit(jobRequest({ attempts: 2, retryDelayMs: 5 }))
    await tick()
    runners[0]!.emit(assistantWithUsage(90))
    runners[0]!.emit(errorResult())
    await tick()

    const queued = await queue.get(job.id)
    expect(queued).toMatchObject({
      status: 'queued',
      attempt: 2,
      maxAttempts: 2,
      error: 'hit max turns',
    })
    expect(queued?.nextRunAt).toBeDefined()
    expect(queued?.sessionId).toBeUndefined()
    expect(events.some((e) => e.type === 'job_retrying')).toBe(true)
    expect(events.some((e) => e.type === 'job_completed')).toBe(false)

    await settles(() => expect(runners).toHaveLength(2))
    runners[1]!.emit(successResult(100))
    await tick()
    const done = await queue.get(job.id)
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 })
    expect(done?.usage.tokens).toBe(200)
    expect(done?.usage.numTurns).toBe(4)
    expect(done?.usage.totalCostUsd).toBeCloseTo(0.25)
    expect(done?.nextRunAt).toBeUndefined()
  })

  it('fails terminally once attempts are exhausted', async () => {
    const { queue, runners, events } = makeQueue()
    const job = await queue.submit(jobRequest({ attempts: 2, retryDelayMs: 1 }))
    await tick()
    runners[0]!.emit(errorResult())
    await settles(() => expect(runners).toHaveLength(2))
    runners[1]!.emit(errorResult())
    await tick()
    expect(await queue.get(job.id)).toMatchObject({ status: 'failed', attempt: 2 })
    expect(events.filter((e) => e.type === 'job_completed')).toHaveLength(1)
  })

  it('does not retry canceled jobs', async () => {
    const { queue, runners } = makeQueue()
    const job = await queue.submit(jobRequest({ attempts: 3, retryDelayMs: 1 }))
    await tick()
    await queue.cancel(job.id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runners).toHaveLength(1)
    expect((await queue.get(job.id))?.status).toBe('canceled')
  })

  it('kills runs that exceed the wall-clock cap, even when the CLI never responds', async () => {
    const { queue, runners } = makeQueue({ maxJobDurationMs: 10, killGraceMs: 10 })
    const job = await queue.submit(jobRequest())
    await tick()
    await settles(() => expect(runners[0]!.interrupt).toHaveBeenCalled())
    await settles(async () => {
      expect((await queue.get(job.id))?.status).toBe('failed')
    })
    expect((await queue.get(job.id))?.error).toMatch(/max duration/)
    expect(runners[0]!.closed).toBe(true)
    expect((await queue.stats()).running).toBe(0)
  })

  it('the per-job maxDurationMs tightens the server cap, never widens it', async () => {
    const { queue, runners } = makeQueue({ maxJobDurationMs: 60_000, killGraceMs: 5 })
    await queue.submit(jobRequest({ maxDurationMs: 5 }))
    await tick()
    await settles(() => expect(runners[0]!.interrupt).toHaveBeenCalled())
  })

  it('prunes terminal jobs past the retention window, never queued/running ones', async () => {
    const adapter = new InMemoryQueueAdapter()
    const { queue, runners } = makeQueue({
      adapter,
      retention: { maxAgeMs: 0, sweepIntervalMs: 60_000 },
    })
    const job = await queue.submit(jobRequest())
    await tick()
    runners[0]!.emit(successResult())
    await settles(async () => expect(await queue.get(job.id)).toBeNull())

    const fresh = await queue.submit(jobRequest())
    expect(await adapter.prune(0)).toBe(0)
    expect(await queue.get(fresh.id)).not.toBeNull()
  })

  it("progress: 'completion' suppresses webhook progress but keeps lifecycle deliveries", async () => {
    const delivered: JobEvent[] = []
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body)) as JobEvent)
      return { ok: true, status: 200 } as Response
    })
    const { queue, runners, events } = makeQueue({ fetchImpl })
    await queue.submit(jobRequest({ webhook: { url: 'https://example.test/hook', progress: 'completion' } }))
    await tick()
    runners[0]!.emit(assistantWithUsage(10))
    runners[0]!.emit(successResult())
    await settles(() => {
      expect(delivered.map((e) => e.type)).toEqual(['job_started', 'job_completed'])
    })
    expect(events.some((e) => e.type === 'job_progress')).toBe(true)
  })

  describe('parked runs (deferred execution)', () => {
    it('frees the concurrency slot while parked and takes it back on resume', async () => {
      const { queue, runners, events } = makeQueue({ maxConcurrency: 1 })
      const a = await queue.submit(jobRequest({ meta: { n: 1 } }))
      const b = await queue.submit(jobRequest({ meta: { n: 2 } }))
      await tick()
      expect(runners).toHaveLength(1)

      expect(queue.onSessionParking(runners[0]!.id, 'exec-1')).toBe(true)
      await settles(async () => expect((await queue.get(a.id))?.status).toBe('parked'))
      expect(await queue.get(a.id)).toMatchObject({ parkedExecutionId: 'exec-1' })
      expect(events.find((e) => e.type === 'job_parked')).toMatchObject({ executionId: 'exec-1' })

      await settles(() => expect(runners).toHaveLength(2))
      const stats = await queue.stats()
      expect(stats).toMatchObject({ running: 1, parked: 1 })
      expect((await queue.get(b.id))?.status).toBe('running')

      const resumed = new FakeRunner()
      queue.onSessionResumed(runners[0]!.id, resumed as unknown as SessionRunner)
      await settles(async () => expect((await queue.get(a.id))?.status).toBe('running'))
      expect(events.find((e) => e.type === 'job_resumed')).toMatchObject({ executionId: 'exec-1' })
      expect((await queue.get(a.id))?.parkedExecutionId).toBeUndefined()

      resumed.emit(successResult(100))
      await settles(async () => expect((await queue.get(a.id))?.status).toBe('succeeded'))
    })

    it('re-subscribes past the replayed log so a resume does not re-deliver progress', async () => {
      const { queue, runners, events } = makeQueue()
      await queue.submit(jobRequest())
      await tick()
      runners[0]!.emit(assistantWithUsage(20, 'before the park'))
      await tick()
      const progressBefore = events.filter((e) => e.type === 'job_progress').length
      expect(progressBefore).toBe(1)

      queue.onSessionParking(runners[0]!.id, 'exec-1')
      await tick()

      const resumed = new FakeRunner()
      resumed.id = runners[0]!.id
      resumed.emit(assistantWithUsage(20, 'before the park'))
      queue.onSessionResumed(runners[0]!.id, resumed as unknown as SessionRunner)
      await tick()

      expect(events.filter((e) => e.type === 'job_progress')).toHaveLength(progressBefore)
    })

    it('excludes parked time from the wall-clock watchdog', async () => {
      vi.useFakeTimers()
      try {
        const { queue, runners } = makeQueue({ maxJobDurationMs: 1000 })
        const job = await queue.submit(jobRequest())
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(600)

        queue.onSessionParking(runners[0]!.id, 'exec-1')
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await queue.get(job.id))?.status).toBe('parked')

        const resumed = new FakeRunner()
        queue.onSessionResumed(runners[0]!.id, resumed as unknown as SessionRunner)
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(300)
        expect((await queue.get(job.id))?.status).toBe('running')
        await vi.advanceTimersByTimeAsync(200)
        await vi.advanceTimersByTimeAsync(6000)
        expect((await queue.get(job.id))?.status).toBe('failed')
      } finally {
        vi.useRealTimers()
      }
    })

    it('fails a run parked longer than maxParkedDurationMs and discards its snapshot', async () => {
      vi.useFakeTimers()
      const discardSession = vi.fn()
      try {
        const { queue, runners } = makeQueue({ maxParkedDurationMs: 5000, discardSession })
        const job = await queue.submit(jobRequest())
        await vi.advanceTimersByTimeAsync(0)
        const sessionId = runners[0]!.id
        queue.onSessionParking(sessionId, 'exec-1')
        await vi.advanceTimersByTimeAsync(0)

        await vi.advanceTimersByTimeAsync(5001)
        const failed = await queue.get(job.id)
        expect(failed?.status).toBe('failed')
        expect(failed?.error).toMatch(/max parked duration/)
        expect(discardSession).toHaveBeenCalledWith(sessionId)
      } finally {
        vi.useRealTimers()
      }
    })

    it('cancels a parked run and discards its snapshot', async () => {
      const discardSession = vi.fn()
      const { queue, runners, events } = makeQueue({ discardSession })
      const job = await queue.submit(jobRequest())
      await tick()
      const sessionId = runners[0]!.id
      queue.onSessionParking(sessionId, 'exec-1')
      await tick()

      const canceled = await queue.cancel(job.id)
      expect(canceled?.status).toBe('canceled')
      expect(discardSession).toHaveBeenCalledWith(sessionId)
      expect((await queue.stats()).parked).toBe(0)
      expect(events.at(-1)).toMatchObject({ type: 'job_completed' })
    })

    it('refuses a park for a run that is already being killed', async () => {
      const { queue, runners } = makeQueue({ sessionTokenLimit: 30 })
      await queue.submit(jobRequest())
      await tick()
      runners[0]!.emit(assistantWithUsage(100))
      await tick()
      expect(runners[0]!.interrupt).toHaveBeenCalled()

      expect(queue.onSessionParking(runners[0]!.id, 'exec-1')).toBe(false)
      expect(queue.onSessionParking('not-a-job-session', 'exec-2')).toBe(true)
    })
  })
})
