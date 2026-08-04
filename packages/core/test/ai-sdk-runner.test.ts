import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import type { SessionEvent } from '@workerdeck/protocol'
import { AiSdkRunner, type AiSdkRunnerConfig } from '../src/index.ts'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}

// The runner streams every model call (doStream, not doGenerate). One entry =
// one LLM call; text arrives as deltas like a real provider would send it.
function textResponse(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      ...[...text].map((ch) => ({ type: 'text-delta' as const, id: 't1', delta: ch })),
      { type: 'text-end' as const, id: 't1' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
    ]),
  }
}

function toolCallResponse(toolCallId: string, toolName: string, input: unknown) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
    ]),
  }
}

function makeRunner(config: Partial<AiSdkRunnerConfig> & { languageModel: AiSdkRunnerConfig['languageModel'] }) {
  const runner = new AiSdkRunner({ ...config })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  void runner.start()
  const eventsOf = (type: string) => events.filter((e) => e.type === type)
  const waitFor = async (predicate: () => boolean, ms = 2000) => {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  return { runner, events, eventsOf, waitFor }
}

describe('AiSdkRunner', () => {
  it('runs a plain text turn: user_message, assistant_message, turn_result, idle', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: textResponse('hello there') })
    const { runner, eventsOf, waitFor } = makeRunner({ languageModel: model })

    runner.sendMessage('hi')
    await waitFor(() => eventsOf('turn_result').length === 1)

    expect(eventsOf('user_message')).toHaveLength(1)
    const assistant = eventsOf('assistant_message')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }], model: 'mock-1' },
    })
    expect(eventsOf('turn_result')[0]).toMatchObject({
      subtype: 'success',
      isError: false,
      numTurns: 1,
      result: 'hello there',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    expect(runner.info().status).toBe('idle')
    expect(runner.info().model).toBe('mock-1')
    // Session surfaces gate CLI-only affordances on this, so the runner reports
    // its own engine rather than the profile being looked back up.
    expect(runner.info().engine).toBe('provider')
  })

  it('executes local tools inside the loop and emits tool_use + synthetic tool_result', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        toolCallResponse('call-1', 'lookup', { key: 'k' }),
        textResponse('found it'),
      ],
    })
    const tools = {
      lookup: tool({
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => ({ value: `${key}-value` }),
      }),
    }
    const harness = makeRunner({ languageModel: model, tools })
    harness.runner.sendMessage('look up k')
    await harness.waitFor(() => harness.eventsOf('turn_result').length === 1)

    const assistantEvents = harness.eventsOf('assistant_message')
    const toolUse = assistantEvents
      .flatMap((e) => ((e as { message: { content: unknown } }).message.content as Array<{ type: string }>))
      .find((b) => b.type === 'tool_use')
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'lookup' })
    const synthetic = harness.eventsOf('user_message').filter((e) => (e as { synthetic?: boolean }).synthetic)
    expect(synthetic.length).toBeGreaterThan(0)
    expect(harness.eventsOf('turn_result')[0]).toMatchObject({ subtype: 'success', result: 'found it' })
    // v7 result.usage is cumulative across steps: two steps of 10/5 each.
    expect(harness.eventsOf('turn_result')[0]).toMatchObject({
      usage: { input_tokens: 20, output_tokens: 10 },
    })
  })

  it('streams: token deltas while text is produced, step messages as steps complete', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [toolCallResponse('c1', 'lookup', { key: 'k' }), textResponse('found it')],
    })
    const tools = {
      lookup: tool({
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => ({ value: `${key}-value` }),
      }),
    }
    const h = makeRunner({ languageModel: model, tools })
    h.runner.sendMessage('go')
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)

    // Token-by-token deltas in the Anthropic content_block_delta shape the
    // reducer already renders ('found it' char-by-char = several deltas).
    const deltas = h.eventsOf('stream_delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas[0]).toMatchObject({
      event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
    })
    // Step messages arrive AS the turn progresses: the tool call and its
    // result are both emitted before the final text message, not in one blob
    // after the loop ends.
    const toolUseSeq = h.eventsOf('assistant_message').find((e) =>
      (e as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === 'tool_use'),
    )!.seq
    const toolResultSeq = h.eventsOf('user_message').find((e) => (e as { synthetic?: boolean }).synthetic)!.seq
    const finalTextSeq = h.eventsOf('assistant_message').find((e) =>
      (e as { message: { content: Array<{ type: string; text?: string }> } }).message.content.some(
        (b) => b.type === 'text' && b.text === 'found it',
      ),
    )!.seq
    expect(toolUseSeq).toBeLessThan(toolResultSeq)
    expect(toolResultSeq).toBeLessThan(finalTextSeq)
  })

  it('emits no stream_delta when includePartialMessages is false', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: textResponse('quiet') })
    const h = makeRunner({ languageModel: model, includePartialMessages: false })
    h.runner.sendMessage('go')
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)
    expect(h.eventsOf('stream_delta')).toHaveLength(0)
    expect(h.eventsOf('turn_result')[0]).toMatchObject({ result: 'quiet' })
  })

  it('parks on an execute-less tool call and resumes via resolveToolCall (message-state replay)', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        toolCallResponse('call-9', 'eval_script', { script: '1+1' }),
        textResponse('the answer is 2'),
      ],
    })
    const tools = {
      // No execute: the loop halts and the call surfaces as a pending execution.
      eval_script: tool({ inputSchema: z.object({ script: z.string() }) }),
    }
    const h = makeRunner({ languageModel: model, tools })
    h.runner.sendMessage('evaluate 1+1')

    await h.waitFor(() => h.runner.pendingToolCalls.length === 1)
    // Parked: no turn_result yet, session still mid-turn.
    expect(h.eventsOf('turn_result')).toHaveLength(0)
    expect(h.runner.pendingToolCalls[0]).toMatchObject({ toolCallId: 'call-9', toolName: 'eval_script' })
    expect(h.runner.info().status).toBe('running')

    // Unknown ids are rejected; the real one is accepted exactly once.
    expect(h.runner.resolveToolCall('nope', { type: 'text', value: 'x' })).toBe(false)
    expect(h.runner.resolveToolCall('call-9', { type: 'json', value: { result: 2 } })).toBe(true)
    expect(h.runner.resolveToolCall('call-9', { type: 'json', value: { result: 2 } })).toBe(false)

    await h.waitFor(() => h.eventsOf('turn_result').length === 1)
    expect(h.eventsOf('turn_result')[0]).toMatchObject({ subtype: 'success', result: 'the answer is 2' })
    expect(h.runner.info().status).toBe('idle')
    // The tool result was appended to the durable message state for the replay.
    const toolMessage = h.runner.messages.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
  })

  it('accounts usage across every leg of a parked turn, not just the final one', async () => {
    // Found by the live smoke: a turn that parks spans several generate() calls,
    // and reporting only the last one silently drops the parked legs' tokens.
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        toolCallResponse('call-1', 'eval_script', { script: 'x' }),
        toolCallResponse('call-2', 'eval_script', { script: 'y' }),
        textResponse('done'),
      ],
    })
    const tools = { eval_script: tool({ inputSchema: z.object({ script: z.string() }) }) }
    const h = makeRunner({ languageModel: model, tools })

    h.runner.sendMessage('go')
    await h.waitFor(() => h.runner.pendingToolCalls.length === 1)
    h.runner.resolveToolCall('call-1', { type: 'text', value: 'first' })
    await h.waitFor(() => h.runner.pendingToolCalls.some((c) => c.toolCallId === 'call-2'))
    h.runner.resolveToolCall('call-2', { type: 'text', value: 'second' })
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)

    // Three legs of 10 in / 5 out each — the two parked legs must not vanish.
    expect(h.eventsOf('turn_result')[0]).toMatchObject({
      subtype: 'success',
      numTurns: 1,
      usage: { input_tokens: 30, output_tokens: 15 },
    })
  })

  it('treats an errored local tool execution as settled, never as a park', async () => {
    // Regression: the SDK reports a thrown `execute` as a `tool-error` part,
    // which is absent from result.toolResults — deriving "settled" from that
    // list parked the session forever on a call the SDK had already answered
    // (hit live: a deepwiki MCP call failing at transport level hung the turn).
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        toolCallResponse('c1', 'flaky', {}),
        textResponse('recovered from the tool failure'),
      ],
    })
    const { runner, eventsOf, waitFor } = makeRunner({
      languageModel: model,
      tools: {
        flaky: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<{ ok: boolean }> => {
            throw new Error('fetch failed')
          },
        }),
      },
    })
    runner.sendMessage('go')

    await waitFor(() => eventsOf('turn_result').length === 1)
    expect(runner.pendingToolCalls).toHaveLength(0)
    expect(eventsOf('turn_result')[0]).toMatchObject({
      subtype: 'success',
      result: 'recovered from the tool failure',
    })
    expect(runner.status).toBe('idle')
  })

  it('interrupt() rescues a parked turn: parked calls fail, the turn ends, input works again', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [toolCallResponse('c1', 'ask_human', { q: 'ok?' }), textResponse('hello again')],
    })
    const { runner, eventsOf, waitFor } = makeRunner({
      languageModel: model,
      tools: { ask_human: tool({ inputSchema: z.object({ q: z.string() }) }) },
    })
    runner.sendMessage('go')
    await waitFor(() => runner.pendingToolCalls.length === 1)

    await runner.interrupt()
    expect(runner.pendingToolCalls).toHaveLength(0)
    expect(eventsOf('turn_result')[0]).toMatchObject({ isError: true, errors: ['interrupted'] })
    expect(runner.status).toBe('idle')
    // The parked call was recorded as an error result, so the history stays
    // replayable and the session accepts new input.
    runner.sendMessage('are you still there?')
    await waitFor(() => eventsOf('turn_result').length === 2)
    expect(eventsOf('turn_result')[1]).toMatchObject({ subtype: 'success', result: 'hello again' })
  })

  it('keeps tool results adjacent to their call when the user typed during the park', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [toolCallResponse('c1', 'ask_human', { q: 'ok?' }), textResponse('done')],
    })
    const { runner, eventsOf, waitFor } = makeRunner({
      languageModel: model,
      tools: { ask_human: tool({ inputSchema: z.object({ q: z.string() }) }) },
    })
    runner.sendMessage('go')
    await waitFor(() => runner.pendingToolCalls.length === 1)

    // Arrives mid-park: must not wedge itself between the call and its result.
    runner.sendMessage('also, one more thing')
    runner.resolveToolCall('c1', { type: 'text', value: 'yes' })
    await waitFor(() => eventsOf('turn_result').length === 1)

    const roles = runner.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
  })

  it('rejects unsupported permission modes at construction and via setPermissionMode', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: textResponse('x') })
    expect(() => new AiSdkRunner({ languageModel: model, permissionMode: 'plan' })).toThrow(
      /not supported/,
    )
    const h = makeRunner({ languageModel: model })
    await expect(h.runner.setPermissionMode('acceptEdits')).rejects.toThrow(/not supported/)
    await expect(h.runner.setPermissionMode('dontAsk')).resolves.toBeUndefined()
    expect(h.eventsOf('permission_mode_changed')).toHaveLength(1)
  })

  it('surfaces turn errors as error_during_execution without killing the session', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: () => {
        throw new Error('provider exploded')
      },
    })
    const h = makeRunner({ languageModel: model })
    h.runner.sendMessage('hi')
    await h.waitFor(() => h.eventsOf('turn_result').length === 1)
    expect(h.eventsOf('turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      isError: true,
      errors: ['provider exploded'],
    })
    expect(h.runner.info().status).toBe('idle')
    expect(() => h.runner.sendMessage('still alive?')).not.toThrow()
  })

  it('close() settles the session and refuses further input', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: textResponse('x') })
    const h = makeRunner({ languageModel: model })
    h.runner.close('server')
    expect(h.eventsOf('session_closed')).toHaveLength(1)
    expect(h.runner.info().status).toBe('closed')
    expect(() => h.runner.sendMessage('hi')).toThrow(/closed/)
  })
})
