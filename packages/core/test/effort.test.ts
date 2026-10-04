import { describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@workerdeck/protocol'
import { SessionRunner } from '../src/index.ts'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { effortDefaultFor } from '../src/lib/effort.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

const RESOLVED: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5' }

function init(model: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-session-1',
    model,
    cwd: '/tmp/project',
    tools: [],
    skills: [],
    slash_commands: [],
    permissionMode: 'default',
    claude_code_version: '2.0.0',
    mcp_servers: [],
    apiKeySource: 'user',
    uuid: 'uuid-init',
  } as unknown as SDKMessage
}

function result(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.1,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'uuid-r',
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage
}

// Stands in for the CLI's settings layer: haiku takes no effort, every other model defaults to medium.
function claudeEngine() {
  const harnesses: ReturnType<typeof fakeHarness>[] = []
  const options: (Options | undefined)[] = []
  const state = { model: RESOLVED.opus!, flag: undefined as string | undefined }
  const applyFlagSettings = vi.fn(async (settings: { effortLevel?: string | null }) => {
    state.flag = settings.effortLevel ?? undefined
  })
  const applied = () => ({ model: state.model, effort: state.model.includes('haiku') ? null : (state.flag ?? 'medium') })
  const queryFn = (params: Parameters<ReturnType<typeof fakeHarness>['queryFn']>[0]) => {
    const harness = fakeHarness()
    harnesses.push(harness)
    const query = harness.queryFn(params) as Query & Record<string, unknown>
    options.push(params.options)
    state.model = RESOLVED[params.options?.model ?? 'opus'] ?? params.options!.model!
    state.flag = params.options?.effort
    harness.setModel.mockImplementation(async (model?: string) => {
      state.model = RESOLVED[model ?? 'opus'] ?? model!
    })
    query.applyFlagSettings = applyFlagSettings
    query.getSettings = vi.fn(async () => ({ applied: applied() }))
    return query
  }
  return { harnesses, options, applyFlagSettings, queryFn, state }
}

async function startClaude(config: Partial<ConstructorParameters<typeof SessionRunner>[0]> = {}) {
  const engine = claudeEngine()
  const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: engine.queryFn, ...config })
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  void runner.start()
  await tick()
  await tick()
  return { engine, runner, events }
}

function efforts(events: SessionEvent[]): Array<string | null> {
  return events.filter((e) => e.type === 'effort_changed').map((e) => (e as { effort: string | null }).effort)
}

describe('effortDefaultFor', () => {
  const models = [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' }]

  it('matches a requested name first, then a catalog alias through its resolved id', () => {
    expect(effortDefaultFor({ opus: 'high' }, models, 'opus')).toBe('high')
    expect(effortDefaultFor({ opus: 'high' }, models, undefined, 'claude-opus-5-5')).toBe('high')
    expect(effortDefaultFor({ 'claude-opus-5-5': 'max', opus: 'high' }, models, 'claude-opus-5-5')).toBe('max')
    expect(effortDefaultFor({ opus: 'high' }, models, undefined, 'claude-opus-5-5[1m]')).toBe('high')
    expect(effortDefaultFor({ 'claude-opus-5-5[1m]': 'max', opus: 'high' }, models, 'claude-opus-5-5[1m]')).toBe('max')
    expect(effortDefaultFor({ opus: 'high' }, models, 'sonnet')).toBeUndefined()
    expect(effortDefaultFor(undefined, models, 'opus')).toBeUndefined()
    expect(effortDefaultFor({}, models, 'constructor')).toBeUndefined()
  })
})

describe('claude reasoning effort', () => {
  it("reports the engine's own default when nothing is configured", async () => {
    const { runner, events, engine } = await startClaude()
    expect(engine.options[0]?.effort).toBeUndefined()
    expect(efforts(events)).toEqual(['medium'])
    expect(runner.info().effort).toBe('medium')
    expect(engine.applyFlagSettings).not.toHaveBeenCalled()
  })

  it('starts on the configured default for the requested model', async () => {
    const { runner, engine } = await startClaude({ model: 'opus', effortDefaults: { opus: 'high' } })
    expect(engine.options[0]?.effort).toBe('high')
    expect(runner.info().effort).toBe('high')
  })

  it('applies a default keyed by alias once an unnamed model resolves to it', async () => {
    const { runner, engine } = await startClaude({ effortDefaults: { opus: 'xhigh' } })
    expect(engine.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' })
    expect(runner.info().effort).toBe('xhigh')
  })

  it('lets an explicit request win over the configured default', async () => {
    const { runner, engine } = await startClaude({ model: 'opus', reasoningEffort: 'low', effortDefaults: { opus: 'high' } })
    expect(engine.options[0]?.effort).toBe('low')
    expect(runner.info().effort).toBe('low')
  })

  it('switches live, and back to the default', async () => {
    const { runner, events, engine } = await startClaude({ model: 'opus' })
    await runner.setEffort('max')
    expect(engine.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'max' })
    expect(runner.info().effort).toBe('max')
    await runner.setEffort()
    expect(engine.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: null })
    expect(efforts(events)).toEqual(['medium', 'max', 'medium'])
  })

  it('refuses a level the engine does not know', async () => {
    const { runner } = await startClaude()
    await expect(runner.setEffort('ultra')).rejects.toThrow(/unsupported reasoning effort/)
  })

  it('reports null on a model without effort, and applies a model default on switch', async () => {
    const { runner, events } = await startClaude({ model: 'opus', effortDefaults: { sonnet: 'high' } })
    await runner.setModel('haiku')
    expect(runner.info().effort).toBeNull()
    await runner.setModel('sonnet')
    expect(runner.info().effort).toBe('high')
    expect(efforts(events)).toEqual(['medium', null, 'high'])
  })

  it('carries an explicit choice to a model without a default, but drops an inherited default', async () => {
    const explicit = await startClaude({ model: 'opus' })
    await explicit.runner.setEffort('xhigh')
    await explicit.runner.setModel('sonnet')
    expect(explicit.runner.info().effort).toBe('xhigh')

    const inherited = await startClaude({ model: 'opus', effortDefaults: { opus: 'high' } })
    await inherited.runner.setModel('sonnet')
    expect(inherited.engine.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: null })
    expect(inherited.runner.info().effort).toBe('medium')
  })

  it('reapplies the chosen effort when an asleep engine wakes', async () => {
    const { runner, engine } = await startClaude({ model: 'opus' })
    runner.sendMessage('first')
    engine.harnesses[0]!.emit(init('claude-opus-5-5'))
    engine.harnesses[0]!.emit(result())
    await tick()
    await runner.setEffort('max')
    expect(await runner.sleep()).toEqual({ ok: true })
    runner.sendMessage('second')
    await tick()
    expect(engine.options[1]?.effort).toBe('max')
  })

  it('tells the model its effort through session_info', async () => {
    const { runner } = await startClaude({ model: 'opus', effortDefaults: { opus: 'high' } })
    const report = await runner.sessionReport()
    expect(report.effort).toBe('high')
  })
})

describe('codex reasoning effort', () => {
  it("reports the thread's resolved effort once the thread opens", async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }))
    const runner = new CodexRunner({ cwd: '/tmp/project', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    expect(runner.info().effort).toBeUndefined()
    await runner.start()
    expect(ofType(events, 'effort_changed').map((e) => e.effort)).toEqual(['medium'])
    expect((await runner.sessionReport()).effort).toBe('medium')
  })

  it('sends the configured default for the model, and a live change on the next turn', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }))
    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      model: 'gpt-6-sol',
      effortDefaults: { 'gpt-6-sol': 'xhigh', 'gpt-6-luna': 'low' },
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    const turns = () => peer.requests.filter((r) => r.method === 'turn/start').map((r) => (r.params as { effort?: string }).effort)
    expect(turns()).toEqual(['xhigh'])

    await expect(runner.setEffort('minimal')).rejects.toThrow(/unsupported reasoning effort/)
    await runner.setEffort('ultra')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(turns()).toEqual(['xhigh', 'ultra']))

    await runner.setModel('gpt-6-luna')
    expect(runner.info().effort).toBe('low')
    expect(ofType(events, 'effort_changed').map((e) => e.effort)).toEqual(['xhigh', 'ultra', 'low'])
  })

  it('drops an explicit level the new model lacks', async () => {
    const peer = scriptedPeer()
    const runner = new CodexRunner({ cwd: '/tmp/project', model: 'gpt-6-sol', reasoningEffort: 'ultra', connectFn: peer.connectFn })
    expect(runner.info().effort).toBe('ultra')
    await runner.setModel('gpt-6-luna')
    expect(runner.info().effort).toBeUndefined()
  })
})
