import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { createVfs } from '@workerdeck/sandbox'
import type { SessionEvent } from '@workerdeck/protocol'
import { AiSdkRunner, DeferredExecutor, type AiSdkRunnerConfig, type DeferredDispatch, type RunnerSnapshot } from '../src/index.ts'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}

const streamText = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: text },
    { type: 'text-end' as const, id: 't1' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
  ]),
})

const streamCalls = (calls: Array<{ id: string; tool: string; input: unknown }>) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    ...calls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: c.id,
      toolName: c.tool,
      input: JSON.stringify(c.input),
    })),
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
  ]),
})

// A turn genuinely in flight. The fake stream has to *watch* the signal: one that merely
// never closes hangs the turn, since the runner's abort cannot cancel an unwired stream.
const streamStalls =
  (text: string) =>
  async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start' as const, warnings: [] })
        controller.enqueue({ type: 'text-start' as const, id: 't1' })
        controller.enqueue({ type: 'text-delta' as const, id: 't1', delta: text })
        abortSignal?.addEventListener('abort', () => controller.error(new Error('interrupted')))
      },
    }),
  })

const TOOLS = { remote_task: tool({ inputSchema: z.object({ task: z.string() }) }) }

const harness = (config: Partial<AiSdkRunnerConfig> & Pick<AiSdkRunnerConfig, 'languageModel'>) => {
  const runner = new AiSdkRunner({ tools: TOOLS, executableTools: ['remote_task'], ...config })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  void runner.start()
  const eventsOf = (type: string) => events.filter((e) => e.type === type)
  const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for condition')
      }
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  return { runner, events, eventsOf, waitFor }
}

describe('deferred execution: park and rehydrate', () => {
  it('announces the park only once every call of the batch has been dispatched', async () => {
    const dispatched: DeferredDispatch[] = []
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCalls([
          { id: 'call-a', tool: 'remote_task', input: { task: 'a' } },
          { id: 'call-b', tool: 'remote_task', input: { task: 'b' } },
        ]),
      ],
    })
    const parkedAtSignal: number[] = []
    const executor = new DeferredExecutor({ onDispatch: (call) => void dispatched.push(call) })
    const h = harness({ languageModel: model, executor })
    h.runner.subscribe((event) => {
      if (event.type === 'status_changed' && event.status === 'parked') {
        parkedAtSignal.push(dispatched.length)
      }
    })

    h.runner.sendMessage('do both')
    await h.waitFor(() => h.runner.info().status === 'parked')

    expect(dispatched.map((d) => d.executionId)).toEqual(['call-a', 'call-b'])
    expect(parkedAtSignal).toEqual([2])
    expect(h.eventsOf('execution_dispatched')).toHaveLength(2)
    expect(h.eventsOf('execution_dispatched')[0]).toMatchObject({
      backend: 'remote',
      deferred: true,
    })
  })

  it('parks, rehydrates under the same id, and completes the turn on the delivered result', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [streamCalls([{ id: 'call-1', tool: 'remote_task', input: { task: 'crunch' } }]), streamText('the remote worker said 42')],
    })
    const vfs = createVfs({ '/notes.txt': 'keep me' })
    const executor = new DeferredExecutor({ onDispatch: () => {} })
    const h = harness({ languageModel: model, executor, vfs, prompt: 'crunch it' })

    await h.waitFor(() => h.runner.info().status === 'parked')
    const snapshot = h.runner.park()!
    expect(snapshot).toBeDefined()
    expect(snapshot.engine).toBe('provider')
    expect(snapshot.parked).toEqual([{ executionId: 'call-1', toolName: 'remote_task', expiresAt: undefined }])
    expect(snapshot.vfs).toEqual({ '/notes.txt': 'keep me' })
    expect(h.eventsOf('session_closed')).toHaveLength(0)
    expect(h.runner.settleExecution('call-1', { status: 'ok', output: 42 })).toBe(false)
    expect(h.runner.park()).toBeUndefined()

    const resumed = new AiSdkRunner({
      languageModel: model,
      tools: TOOLS,
      executableTools: ['remote_task'],
      executor,
      prompt: 'crunch it',
      vfs: createVfs(snapshot.vfs),
      restore: snapshot,
    })
    const after: SessionEvent[] = []
    resumed.subscribe((e) => after.push(e), snapshot.seq)
    void resumed.start()

    expect(resumed.id).toBe(h.runner.id)
    expect(resumed.info().status).toBe('parked')
    expect(after).toHaveLength(0)
    expect(resumed.vfs?.read('/notes.txt')).toBe('keep me')

    expect(resumed.settleExecution('call-1', { status: 'ok', output: { answer: 42 } })).toBe(true)
    expect(resumed.settleExecution('call-1', { status: 'ok', output: { answer: 42 } })).toBe(false)

    const deadline = Date.now() + 2000
    while (!after.some((e) => e.type === 'turn_result')) {
      if (Date.now() > deadline) {
        throw new Error('the resumed turn never finished')
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = after.find((e) => e.type === 'turn_result')!
    expect(result).toMatchObject({ subtype: 'success', result: 'the remote worker said 42' })
    expect(result).toMatchObject({ numTurns: 1, usage: { input_tokens: 20, output_tokens: 10 } })
    expect(Math.min(...after.map((e) => e.seq))).toBeGreaterThan(snapshot.seq)
    expect(resumed.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('stays parked until every deferred call is settled', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCalls([
          { id: 'call-a', tool: 'remote_task', input: { task: 'a' } },
          { id: 'call-b', tool: 'remote_task', input: { task: 'b' } },
        ]),
        streamText('both done'),
      ],
    })
    const executor = new DeferredExecutor({ onDispatch: () => {} })
    const h = harness({ languageModel: model, executor })
    h.runner.sendMessage('go')
    await h.waitFor(() => h.runner.info().status === 'parked')

    const snapshot = h.runner.park()!
    expect(snapshot.parked).toHaveLength(2)

    const resumed = new AiSdkRunner({
      languageModel: model,
      tools: TOOLS,
      executableTools: ['remote_task'],
      executor,
      restore: snapshot,
    })
    void resumed.start()
    resumed.settleExecution('call-a', { status: 'ok', output: 'a done' })
    expect(resumed.info().status).toBe('parked')
    const second = resumed.park()!
    expect(second.parked).toEqual([{ executionId: 'call-b', toolName: 'remote_task', expiresAt: undefined }])
    const state = second.state as { messages: Array<{ role: string }> }
    expect(state.messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('feeds a failed delivery into the loop as ordinary tool output', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCalls([{ id: 'call-1', tool: 'remote_task', input: { task: 'x' } }]),
        streamText('the worker timed out, here is what I can say'),
      ],
    })
    const executor = new DeferredExecutor({ onDispatch: () => {}, timeoutMs: 60_000 })
    const h = harness({ languageModel: model, executor })
    h.runner.sendMessage('go')
    await h.waitFor(() => h.runner.info().status === 'parked')

    const snapshot = h.runner.park()!
    expect(snapshot.parked[0]!.expiresAt).toBeGreaterThan(Date.now())

    const resumed = new AiSdkRunner({
      languageModel: model,
      tools: TOOLS,
      executableTools: ['remote_task'],
      executor,
      restore: snapshot,
    })
    const after: SessionEvent[] = []
    resumed.subscribe((e) => after.push(e), snapshot.seq)
    void resumed.start()
    resumed.settleExecution('call-1', {
      status: 'failed',
      reason: 'timeout',
      error: 'no result before the deadline',
    })

    const deadline = Date.now() + 2000
    while (!after.some((e) => e.type === 'turn_result')) {
      if (Date.now() > deadline) {
        throw new Error('the resumed turn never finished')
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(after.find((e) => e.type === 'execution_failed')).toMatchObject({ reason: 'timeout' })
    expect(after.find((e) => e.type === 'turn_result')).toMatchObject({ subtype: 'success' })
  })

  it('refuses to park a session that has nothing to wait for', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: [streamText('hi')] })
    const h = harness({ languageModel: model })
    h.runner.sendMessage('hello')
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)
    expect(h.runner.park()).toBeUndefined()
  })

  it('does not announce a park while an in-process execution is still in flight', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCalls([
          { id: 'call-fast', tool: 'remote_task', input: { task: 'fast' } },
          { id: 'call-slow', tool: 'remote_task', input: { task: 'slow' } },
        ]),
      ],
    })
    const h = harness({
      languageModel: model,
      executor: {
        describe: (call) => (call.executionId === 'call-slow' ? { deferred: true, backend: 'remote' } : {}),
        dispatch: (call) =>
          Promise.resolve(
            call.executionId === 'call-slow'
              ? { executionId: call.executionId, status: 'pending' as const }
              : { executionId: call.executionId, status: 'pending' as const },
          ),
      },
    })
    h.runner.sendMessage('go')
    await h.waitFor(() => h.eventsOf('execution_dispatched').length === 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.runner.info().status).toBe('running')
    expect(h.runner.park()).toBeUndefined()
  })

  it('snapshots an idle session without ending it — the case park() refuses', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [streamText('hi there'), streamText('and again')],
    })
    const vfs = createVfs({ '/notes.txt': 'keep me' })
    const h = harness({ languageModel: model, vfs })
    h.runner.sendMessage('hello')
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)

    expect(h.runner.park()).toBeUndefined()
    const snapshot = h.runner.snapshot()!
    expect(snapshot).toBeDefined()
    expect(snapshot.parked).toEqual([])
    expect(snapshot.vfs).toEqual({ '/notes.txt': 'keep me' })

    expect(h.runner.info().status).toBe('idle')
    expect(h.eventsOf('session_closed')).toHaveLength(0)
    expect(h.eventsOf('status_changed').some((e) => 'status' in e && e.status === 'parked')).toBe(false)
    const before = h.events.length
    h.runner.sendMessage('again')
    await h.waitFor(() => h.eventsOf('turn_result').length === 2)
    expect(h.events.length).toBeGreaterThan(before)
  })

  it('drops stream deltas from the snapshot and nothing else', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: [streamText('hi there')] })
    const h = harness({ languageModel: model })
    h.runner.sendMessage('hello')
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)

    const snapshot = h.runner.snapshot()!
    expect(h.eventsOf('stream_delta').length).toBeGreaterThan(0)
    expect(snapshot.events.some((e) => e.type === 'stream_delta')).toBe(false)
    expect(snapshot.events.map((e) => e.type)).toEqual(h.events.filter((e) => e.type !== 'stream_delta').map((e) => e.type))
    expect(snapshot.events.at(-1)?.seq).toBe(snapshot.seq)
    const message = snapshot.events.find((e) => e.type === 'assistant_message')
    expect(JSON.stringify(message)).toContain('hi there')
  })

  it('refuses to snapshot a turn in flight', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [streamCalls([{ id: 'call-fast', tool: 'remote_task', input: { task: 'fast' } }])],
    })
    const h = harness({
      languageModel: model,
      executor: {
        describe: () => ({}),
        dispatch: (call) => Promise.resolve({ executionId: call.executionId, status: 'pending' as const }),
      },
    })
    h.runner.sendMessage('go')
    await h.waitFor(() => h.eventsOf('execution_dispatched').length === 1)
    expect(h.runner.snapshot()).toBeUndefined()
  })

  it('does not re-run an interrupted turn when restored', async () => {
    const stall = streamStalls('a long half-writ')
    let leg = 0
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      // Leg 0 stalls until interrupted; a second leg — which must not happen — answers
      // immediately and is unmissable.
      doStream: (options) => (leg++ === 0 ? stall(options) : Promise.resolve(streamText('SHOULD NOT HAPPEN'))),
    })
    const h = harness({ languageModel: model })
    h.runner.sendMessage('write me an essay')
    // Interrupted mid-flight: a turn that already finished leaves the history ending on the
    // assistant, where `#runTurn`'s own guard would cover for a wrongly scheduled restore.
    await h.waitFor(() => h.eventsOf('stream_delta').length > 0)
    await h.runner.interrupt()
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)
    expect(h.eventsOf('turn_result')[0]).toMatchObject({ isError: true })
    expect(h.runner.messages.at(-1)?.role).toBe('user')

    const snapshot = h.runner.snapshot()!

    const resumed = new AiSdkRunner({
      languageModel: model,
      tools: TOOLS,
      executableTools: ['remote_task'],
      prompt: 'write me an essay',
      restore: snapshot,
    })
    const after: SessionEvent[] = []
    resumed.subscribe((e) => after.push(e), snapshot.seq)
    void resumed.start()
    // Long enough for a wrongly scheduled turn to have started and emitted something.
    await new Promise((r) => setTimeout(r, 50))

    expect(after.filter((e) => e.type === 'turn_result')).toHaveLength(0)
    expect(after.some((e) => e.type === 'status_changed' && 'status' in e && e.status === 'running')).toBe(false)
    expect(resumed.info().status).not.toBe('running')
  })

  it('rejects a snapshot from another engine', () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: [streamText('x')] })
    const alien: RunnerSnapshot = {
      engine: 'claude',
      id: 'x',
      createdAt: Date.now(),
      seq: 1,
      events: [],
      parked: [],
      state: {},
    }
    expect(() => new AiSdkRunner({ languageModel: model, restore: alien })).toThrow(/claude/)
  })
})
