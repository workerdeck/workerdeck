import { afterEach, describe, expect, it } from 'vitest'
import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import type {
  ProfileInfo,
  RateLimitInfo,
  SessionEvent,
  SessionEventBody,
  SessionInfo,
} from '@workerdeck/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

/**
 * A runner that reports plan usage on demand. `emitRateLimit` takes an explicit
 * event timestamp because the tracker's whole ordering rule — last-write-wins
 * by the event's own clock, not arrival order — is what these tests pin: a
 * replayed old reading arriving *after* a fresh one must lose.
 */
class ReportingRunner implements Runner {
  readonly id: string
  readonly createdAt = Date.now()
  readonly pendingApprovals = []
  readonly config: SessionRunnerConfig
  #events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0

  constructor(id: string, config: SessionRunnerConfig) {
    this.id = id
    this.config = config
  }

  emitRateLimit(info: RateLimitInfo, ts = Date.now()): void {
    this.#emit({ type: 'rate_limit', info }, ts)
  }

  async start(): Promise<void> {}

  info(): SessionInfo {
    return {
      id: this.id,
      status: 'idle',
      cwd: this.config.cwd ?? '',
      profile: this.config.profile,
      engine: 'provider',
      model: 'test-model',
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
    }
  }

  subscribe(listener: (event: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.#events) if (event.seq > afterSeq) listener(event)
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  sendMessage(): void {}
  setTitle(): void {}
  resolvePermission(): boolean {
    return false
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  close(): void {
    this.#emit({ type: 'session_closed', reason: 'server' }, Date.now())
  }

  #emit(body: SessionEventBody, ts: number): void {
    const event = { ...body, seq: ++this.#seq, ts } as SessionEvent
    this.#events.push(event)
    for (const listener of this.#listeners) listener(event)
  }
}

const profile = (name: string): ProfileInfo => ({
  name,
  engine: 'provider',
  provider: { id: 'test', model: 'test-model' },
})

type Gateway = { server: WorkerServer; base: string; built: ReportingRunner[] }

const servers: WorkerServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

async function startGateway(): Promise<Gateway> {
  const built: ReportingRunner[] = []
  const server = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    profiles: [profile('plan-a'), profile('plan-b')],
    createEngineRunner: ({ config }) => {
      const runner = new ReportingRunner(`session-${built.length + 1}`, config)
      built.push(runner)
      return runner
    },
  })
  servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, base: `http://127.0.0.1:${port}/v1`, built }
}

const create = async (base: string, profileName: string): Promise<SessionInfo> => {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', profile: profileName }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session
}

const getProfile = async (base: string, name: string): Promise<ProfileInfo> => {
  const res = await fetch(`${base}/profiles`)
  expect(res.status).toBe(200)
  const { profiles } = (await res.json()) as { profiles: ProfileInfo[] }
  const found = profiles.find((p) => p.name === name)
  expect(found).toBeDefined()
  return found!
}

/** Epoch seconds (the protocol's `resetsAt` unit), offset from now in ms. */
const resetsAtIn = (offsetMs: number): number => (Date.now() + offsetMs) / 1000

describe('per-profile plan usage on GET /profiles', () => {
  it('serves the newest reading per window, last-write-wins across the profile\'s sessions', async () => {
    const gateway = await startGateway()
    await create(gateway.base, 'plan-a')

    // Nothing reported yet: absent means unknown — never an empty map, never 0%.
    expect((await getProfile(gateway.base, 'plan-a')).usage).toBeUndefined()

    const first = gateway.built[0]!
    const t1 = Date.now() - 5_000
    const fiveHourResets = resetsAtIn(60 * 60_000)
    first.emitRateLimit(
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 42, resetsAt: fiveHourResets },
      t1,
    )
    first.emitRateLimit(
      { status: 'allowed', rateLimitType: 'seven_day', utilization: 10, resetsAt: resetsAtIn(3 * 86_400_000) },
      t1,
    )

    let usage = (await getProfile(gateway.base, 'plan-a')).usage
    expect(usage?.five_hour).toEqual({
      info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 42, resetsAt: fiveHourResets },
      updatedAt: t1,
    })
    expect(usage?.seven_day?.info.utilization).toBe(10)

    // A newer reading from the same session replaces only its own window.
    const t2 = t1 + 2_000
    first.emitRateLimit(
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 63, resetsAt: fiveHourResets },
      t2,
    )
    usage = (await getProfile(gateway.base, 'plan-a')).usage
    expect(usage?.five_hour?.info.utilization).toBe(63)
    expect(usage?.five_hour?.updatedAt).toBe(t2)
    expect(usage?.seven_day?.info.utilization).toBe(10)

    // A second session on the same profile feeds the same state: the account is
    // the profile, not the session.
    await create(gateway.base, 'plan-a')
    const second = gateway.built[1]!
    const t3 = t2 + 2_000
    second.emitRateLimit(
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 70, resetsAt: fiveHourResets },
      t3,
    )
    usage = (await getProfile(gateway.base, 'plan-a')).usage
    expect(usage?.five_hour?.info.utilization).toBe(70)

    // The stale case this feature exists for: a reading with an *older* event
    // timestamp arriving later (a replayed idle session's log) must not clobber
    // the fresher truth another session already reported.
    first.emitRateLimit(
      { status: 'allowed', rateLimitType: 'five_hour', utilization: 55, resetsAt: fiveHourResets },
      t1,
    )
    usage = (await getProfile(gateway.base, 'plan-a')).usage
    expect(usage?.five_hour?.info.utilization).toBe(70)
    expect(usage?.five_hour?.updatedAt).toBe(t3)
  })

  it('keeps profiles apart — a reading on one account says nothing about another', async () => {
    const gateway = await startGateway()
    await create(gateway.base, 'plan-a')
    await create(gateway.base, 'plan-b')
    gateway.built[1]!.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 5,
      resetsAt: resetsAtIn(60 * 60_000),
    })

    expect((await getProfile(gateway.base, 'plan-a')).usage).toBeUndefined()
    expect((await getProfile(gateway.base, 'plan-b')).usage?.five_hour?.info.utilization).toBe(5)
  })

  it('zeroes a window whose reset has passed, and labels the inference', async () => {
    const gateway = await startGateway()
    await create(gateway.base, 'plan-a')
    const runner = gateway.built[0]!
    const reportedAt = Date.now() - 10 * 60_000

    // 91% of a window that reset a minute ago: the number is provably wrong now.
    runner.emitRateLimit(
      {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 91,
        resetsAt: resetsAtIn(-60_000),
        isUsingOverage: true,
      },
      reportedAt,
    )
    // An engine-reported 0 with a live reset time, for contrast.
    runner.emitRateLimit(
      { status: 'allowed', rateLimitType: 'seven_day', utilization: 0, resetsAt: resetsAtIn(86_400_000) },
      reportedAt,
    )

    const usage = (await getProfile(gateway.base, 'plan-a')).usage
    // Inferred: utilization 0 as a floor, elapsed resetsAt (and the previous
    // window's status/overage) dropped, and the flag that keeps it honest.
    expect(usage?.five_hour).toEqual({
      info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0 },
      updatedAt: reportedAt,
      inferredReset: true,
    })
    // Reported 0 carries no flag — the two zeros stay distinguishable.
    expect(usage?.seven_day?.info.utilization).toBe(0)
    expect(usage?.seven_day?.inferredReset).toBeUndefined()

    // A fresh reading lands by timestamp and ends the inference.
    runner.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 3,
      resetsAt: resetsAtIn(5 * 60 * 60_000),
    })
    const after = (await getProfile(gateway.base, 'plan-a')).usage
    expect(after?.five_hour?.info.utilization).toBe(3)
    expect(after?.five_hour?.inferredReset).toBeUndefined()
  })

  it('leaves a reading without a reset time alone — there is nothing to infer from', async () => {
    const gateway = await startGateway()
    await create(gateway.base, 'plan-a')
    const reportedAt = Date.now() - 3 * 86_400_000
    gateway.built[0]!.emitRateLimit(
      { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 44 },
      reportedAt,
    )

    const usage = (await getProfile(gateway.base, 'plan-a')).usage
    // Days old and served as-is: without `resetsAt` the server cannot know the
    // window rolled, and a stale reading beats an invented one. `updatedAt` is
    // what lets a client say how old it is.
    expect(usage?.seven_day_opus).toEqual({
      info: { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 44 },
      updatedAt: reportedAt,
    })
  })

  it('answers the same on the detail route as in the list', async () => {
    // The detail route had served the bare stored record, so a profile page
    // could learn *less* about a profile than the list it was opened from — and
    // the one client that renders plan usage without a session open is that
    // page. Same decoration, one `forResponse`.
    const gateway = await startGateway()
    await create(gateway.base, 'plan-a')
    gateway.built[0]!.emitRateLimit({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 61,
      resetsAt: resetsAtIn(60 * 60_000),
    })

    const res = await fetch(`${gateway.base}/profiles/plan-a`)
    expect(res.status).toBe(200)
    const { profile } = (await res.json()) as { profile: ProfileInfo }
    expect(profile.usage?.five_hour?.info.utilization).toBe(61)
    // The rest of the decoration rides along, for the same reason.
    expect(profile.capabilities).toBeDefined()
  })
})
