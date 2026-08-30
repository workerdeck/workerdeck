import { beforeAll, describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import type { SessionEvent } from '@workerdeck/protocol'
import { AiSdkRunner, QuickJsExecutor } from '../src/index.ts'

let engine: SandboxEngine
beforeAll(async () => {
  engine = await loadEngine(variant)
})

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}
const streamText = (t: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: t },
    { type: 'text-end' as const, id: 't1' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
  ]),
})
const streamCall = (toolCallId: string, toolName: string, input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
  ]),
})

const waitFor = async (predicate: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * The M1+M2 seam end to end: the model calls an execute-less `eval_script`
 * tool, which parks the loop; the host dispatches it through the sandbox
 * backend against a scoped VFS; the result is fed back and the loop resumes by
 * message-state replay. This is the shape the browser-bridge and deferred
 * backends slot into unchanged — only the executor differs.
 */
describe('agent loop + sandboxed tool execution', () => {
  it('parks on eval_script, executes it in the sandbox, and completes the turn', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCall('call-1', 'eval_script', {
          script: `
            const doc = vfs.read('/leads/acme.txt')
            const revenue = Number(doc.split('revenue:')[1].trim())
            vfs.write('/out/acme.json', JSON.stringify({ revenue }))
            revenue >= 100 ? 'qualified' : 'skip'
          `,
        }),
        streamText('Acme is qualified.'),
      ],
    })

    const runner = new AiSdkRunner({
      languageModel: model,
      // No `execute`: execution is the host's job, via the ToolExecutor seam.
      tools: { eval_script: tool({ inputSchema: z.object({ script: z.string() }) }) },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()

    const vfs = createVfs({ '/leads/acme.txt': 'revenue: 120' })
    const executor = new QuickJsExecutor({ engine })

    runner.sendMessage('evaluate the Acme lead')

    // The loop parks: a pending execution, and no turn_result yet.
    await waitFor(() => runner.pendingToolCalls.length === 1)
    expect(events.some((e) => e.type === 'turn_result')).toBe(false)

    const pending = runner.pendingToolCalls[0]!
    const dispatch = await executor.dispatch({
      executionId: pending.toolCallId,
      sessionId: runner.id,
      tool: pending.toolName,
      input: pending.input,
      vfs,
    })
    expect(dispatch.status).toBe('settled')
    const result = (dispatch as { result: { status: string; output: unknown } }).result
    expect(result).toMatchObject({ status: 'ok', output: 'qualified' })

    // Feed it back; the loop re-enters by replay and finishes the turn.
    expect(runner.resolveToolCall(pending.toolCallId, { type: 'json', value: result.output })).toBe(true)
    await waitFor(() => events.some((e) => e.type === 'turn_result'))

    expect(events.find((e) => e.type === 'turn_result')).toMatchObject({
      subtype: 'success',
      isError: false,
      result: 'Acme is qualified.',
    })
    expect(runner.info().status).toBe('idle')
    // The script's side effect landed in the scoped VFS, not on the host disk.
    expect(vfs.read('/out/acme.json')).toBe('{"revenue":120}')
    // The transcript shows the tool call and its result.
    const toolUse = events
      .filter((e) => e.type === 'assistant_message')
      .flatMap((e) => (e as { message: { content: unknown } }).message.content as Array<{ type: string }>)
      .find((b) => b.type === 'tool_use')
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'eval_script' })
  })

  it('feeds a sandbox failure back into the loop so the model can adapt', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCall('call-2', 'eval_script', { script: 'while (true) {}' }),
        streamText('That script timed out; trying a simpler approach.'),
      ],
    })
    const runner = new AiSdkRunner({
      languageModel: model,
      tools: { eval_script: tool({ inputSchema: z.object({ script: z.string() }) }) },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    const executor = new QuickJsExecutor({ engine })

    runner.sendMessage('run something pathological')
    await waitFor(() => runner.pendingToolCalls.length === 1)

    const pending = runner.pendingToolCalls[0]!
    const dispatch = await executor.dispatch({
      executionId: pending.toolCallId,
      sessionId: runner.id,
      tool: pending.toolName,
      input: pending.input,
      limits: { timeoutMs: 150 },
    })
    const result = (dispatch as { result: { status: string; reason?: string; error?: string } }).result
    expect(result).toMatchObject({ status: 'failed', reason: 'timeout' })

    // A failed execution is ordinary loop input, not a session error.
    runner.resolveToolCall(pending.toolCallId, { type: 'text', value: `${result.reason}: ${result.error}` }, { isError: true })
    await waitFor(() => events.some((e) => e.type === 'turn_result'))
    expect(events.find((e) => e.type === 'turn_result')).toMatchObject({
      subtype: 'success',
      isError: false,
      result: 'That script timed out; trying a simpler approach.',
    })
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(runner.info().status).toBe('idle')
  })
})
