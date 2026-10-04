import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionInfo } from '@workerdeck/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'
import { fakeHarness, frameCollector, listenOn } from './helpers.ts'

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function withSettings(harness: ReturnType<typeof fakeHarness>) {
  let effort: string | null = 'medium'
  const applyFlagSettings = vi.fn(async (settings: { effortLevel?: string | null }) => {
    effort = settings.effortLevel ?? 'medium'
  })
  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const query = harness.queryFn(params) as Query & Record<string, unknown>
    effort = params.options?.effort ?? 'medium'
    query.applyFlagSettings = applyFlagSettings
    query.getSettings = async () => ({ applied: { model: 'claude-opus-5-5', effort } })
    return query
  }
  return { applyFlagSettings, queryFn }
}

async function create(base: string, body: Record<string, unknown>): Promise<SessionInfo> {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/tmp/project', ...body }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: SessionInfo }).session
}

describe('reasoning effort', () => {
  it('starts a session on the gateway default for its model and switches it over WS', async () => {
    const harness = fakeHarness()
    const engine = withSettings(harness)
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      effortDefaults: { opus: 'high' },
      buildRunnerConfig: (req) => ({ ...req, queryFn: engine.queryFn }),
    })
    const { base, wsBase } = await listenOn(running)
    const session = await create(base, { model: 'opus' })
    expect(harness.captured.options?.effort).toBe('high')

    const ws = new WebSocket(`${wsBase}/sessions/${session.id}/ws`)
    const collector = frameCollector(ws)
    await collector.waitFor((f) => f.type === 'attached')
    ws.send(JSON.stringify({ type: 'set_effort', effort: 'max' }))
    await collector.waitFor((f) => f.type === 'event' && f.event.type === 'effort_changed' && f.event.effort === 'max')
    expect(engine.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' })

    const current = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as { session: SessionInfo }
    expect(current.session.effort).toBe('max')

    ws.send(JSON.stringify({ type: 'set_effort', effort: 'turbo' }))
    const refused = await collector.waitFor((f) => f.type === 'protocol_error')
    expect(refused).toMatchObject({ message: expect.stringMatching(/unsupported reasoning effort 'turbo'/) })
    ws.close()
  })

  it('leaves the effort to the engine when nothing is configured', async () => {
    const harness = fakeHarness()
    const engine = withSettings(harness)
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      buildRunnerConfig: (req) => ({ ...req, queryFn: engine.queryFn }),
    })
    const { base } = await listenOn(running)
    await create(base, { model: 'opus' })
    expect(harness.captured.options?.effort).toBeUndefined()
  })

  it('refuses a malformed effortDefaults at construction', () => {
    expect(() =>
      createWorkerServer({ allowUnauthenticated: true, effortDefaults: { opus: 3 } as unknown as Record<string, string> }),
    ).toThrow(/effortDefaults/)
  })
})
