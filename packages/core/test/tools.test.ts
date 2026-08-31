import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { tool } from 'ai'
import { z } from 'zod'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import type { SessionEvent } from '@workerdeck/protocol'
import { AiSdkRunner, QuickJsExecutor, createToolContext, withMcpTools, type ToolExecutionResult, type ToolExecutor } from '../src/index.ts'

let engine: SandboxEngine
beforeAll(async () => {
  engine = await loadEngine(variant)
})

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}
function text(t: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      { type: 'text-delta' as const, id: 't1', delta: t },
      { type: 'text-end' as const, id: 't1' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
    ]),
  }
}
function call(id: string, name: string, input: unknown) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) },
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
    ]),
  }
}

function stubExecutor(): ToolExecutor {
  return {
    dispatch: async (c) => ({
      executionId: c.executionId,
      status: 'settled',
      result: { status: 'ok', output: null } satisfies ToolExecutionResult,
    }),
  }
}

describe('capability-scoped tool set', () => {
  it('grants only what the host supplied a backend for', () => {
    const minimal = createToolContext({ executor: stubExecutor(), sessionId: 's' })
    expect(Object.keys(minimal.tools).sort()).toEqual(['eval_script', 'fs_list', 'fs_read', 'fs_write'])
    const full = createToolContext({
      executor: stubExecutor(),
      sessionId: 's',
      search: async () => [],
      download: async () => ({ text: '' }),
    })
    expect(Object.keys(full.tools)).toContain('web_search')
    expect(Object.keys(full.tools)).toContain('download')
  })

  it('marks only eval_script as sandboxed; everything else is authoritative', () => {
    const context = createToolContext({
      executor: stubExecutor(),
      sessionId: 's',
      search: async () => [],
      download: async () => ({ text: '' }),
    })
    expect(context.sandboxedToolNames).toEqual(['eval_script'])
    const authoritative = context.definitions.filter((d) => d.trust === 'authoritative')
    expect(authoritative.map((d) => d.name).sort()).toEqual(['download', 'fs_list', 'fs_read', 'fs_write', 'web_search'])
  })

  it('declares sandboxed tools without execute so they ride the executor seam', () => {
    const context = createToolContext({ executor: stubExecutor(), sessionId: 's' })
    expect(context.tools.eval_script!.execute).toBeUndefined()
    expect(context.tools.fs_read!.execute).toBeTypeOf('function')
  })

  it('treats MCP tools as authoritative and refuses a name collision', () => {
    const base = createToolContext({ executor: stubExecutor(), sessionId: 's' })
    const withMcp = withMcpTools(base, {
      import_leads: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
    })
    expect(withMcp.definitions.find((d) => d.name === 'import_leads')?.trust).toBe('authoritative')
    expect(withMcp.sandboxedToolNames).toEqual(['eval_script'])

    expect(() => withMcpTools(base, { eval_script: tool({ inputSchema: z.object({}) }) })).toThrow(/collides/)
  })

  it('keeps fs_* on the scratch VFS, never the host disk', async () => {
    const vfs = createVfs()
    const context = createToolContext({ executor: stubExecutor(), sessionId: 's', vfs })
    const write = context.tools.fs_write!.execute!
    const read = context.tools.fs_read!.execute!
    await write({ path: '/notes.txt', content: 'hello' }, {} as never)
    expect(vfs.read('/notes.txt')).toBe('hello')
    expect(await read({ path: '/etc/passwd' }, {} as never)).toMatchObject({
      error: expect.stringContaining('no such file'),
    })
  })

  it('grants deliver_file only when the host listens, and validates the path', async () => {
    const withoutListener = createToolContext({ executor: stubExecutor(), sessionId: 's' })
    expect(withoutListener.tools.deliver_file).toBeUndefined()

    const delivered: unknown[] = []
    const vfs = createVfs({ '/SUMMARY.md': '# Summary' })
    const context = createToolContext({
      executor: stubExecutor(),
      sessionId: 's',
      vfs,
      onFileDelivered: (file) => delivered.push(file),
    })
    const deliver = context.tools.deliver_file!.execute!
    expect(await deliver({ path: '/missing.md' }, {} as never)).toMatchObject({
      error: expect.stringContaining('no such file'),
    })
    expect(delivered).toEqual([])
    expect(await deliver({ path: '/SUMMARY.md', description: 'the summary' }, {} as never)).toMatchObject({ delivered: true, bytes: 9 })
    expect(delivered).toEqual([{ path: '/SUMMARY.md', bytes: 9, description: 'the summary' }])
  })

  it('grants web_fetch only with a backend and turns its failures into data', async () => {
    const withoutBackend = createToolContext({ executor: stubExecutor(), sessionId: 's' })
    expect(withoutBackend.tools.web_fetch).toBeUndefined()

    const context = createToolContext({
      executor: stubExecutor(),
      sessionId: 's',
      webFetch: async () => {
        throw new Error('boom')
      },
    })
    expect(context.definitions.find((d) => d.name === 'web_fetch')?.trust).toBe('authoritative')
    const result = await context.tools.web_fetch!.execute!({ url: 'http://203.0.113.5/', prompt: 'what?' }, {} as never)
    expect(result).toMatchObject({ error: 'boom' })
  })

  it('turns a failed download into data the agent can react to', async () => {
    const context = createToolContext({
      executor: stubExecutor(),
      sessionId: 's',
      download: async () => {
        throw new Error('404 not found')
      },
    })
    const result = await context.tools.download!.execute!({ url: 'https://x.example/doc', path: '/doc.txt' }, {} as never)
    expect(result).toMatchObject({ error: '404 not found' })
  })
})

describe('runner-driven tool execution', () => {
  it('runs the enrich workflow: download, sandboxed eval, authoritative push', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        call('c1', 'download', { url: 'https://acme.example/about', path: '/leads/acme.txt' }),
        call('c2', 'eval_script', {
          script: `const doc = vfs.read('/leads/acme.txt')
                   const revenue = Number(doc.split('revenue:')[1].trim())
                   revenue >= 100 ? 'qualified' : 'skip'`,
        }),
        call('c3', 'push_score', { lead: 'acme', score: 'qualified' }),
        text('Acme is qualified.'),
      ],
    })

    const pushed: unknown[] = []
    const vfs = createVfs()
    const base = createToolContext({
      executor: new QuickJsExecutor({ engine }),
      sessionId: 'sess-1',
      vfs,
      download: async () => ({ text: 'revenue: 120' }),
    })
    const context = withMcpTools(base, {
      push_score: tool({
        inputSchema: z.object({ lead: z.string(), score: z.string() }),
        execute: async (input) => {
          pushed.push(input)
          return { ok: true }
        },
      }),
    })

    const runner = new AiSdkRunner({
      languageModel: model,
      tools: context.tools,
      vfs,
      executor: new QuickJsExecutor({ engine }),
      executableTools: context.sandboxedToolNames,
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('evaluate the acme lead')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })

    expect(vfs.read('/leads/acme.txt')).toBe('revenue: 120')
    expect(pushed).toEqual([{ lead: 'acme', score: 'qualified' }])
    expect(events.find((e) => e.type === 'turn_result')).toMatchObject({
      subtype: 'success',
      result: 'Acme is qualified.',
    })
    expect(events.find((e) => e.type === 'execution_dispatched')).toMatchObject({
      executionId: 'c2',
      toolName: 'eval_script',
      backend: 'server',
    })
    expect(events.find((e) => e.type === 'execution_result')).toMatchObject({ executionId: 'c2' })
  }, 30_000)

  it('feeds a sandbox failure back as tool output instead of failing the session', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [call('c1', 'eval_script', { script: 'while (true) {}' }), text('That timed out; trying something simpler.')],
    })
    const context = createToolContext({ executor: new QuickJsExecutor({ engine }), sessionId: 's' })
    const runner = new AiSdkRunner({
      languageModel: model,
      tools: context.tools,
      executor: new QuickJsExecutor({ engine }),
      executableTools: context.sandboxedToolNames,
      executionLimits: { timeoutMs: 200 },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('go')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    expect(events.find((e) => e.type === 'execution_failed')).toMatchObject({
      executionId: 'c1',
      reason: 'timeout',
    })
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(events.find((e) => e.type === 'turn_result')).toMatchObject({ subtype: 'success' })
  }, 30_000)

  it('leaves calls the executor does not own for the host to answer', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [call('c1', 'ask_human', { q: 'ok?' }), text('done')],
    })
    const dispatched: string[] = []
    const executor: ToolExecutor = {
      dispatch: async (c) => {
        dispatched.push(c.tool)
        return { executionId: c.executionId, status: 'settled', result: { status: 'ok', output: 1 } }
      },
    }
    const runner = new AiSdkRunner({
      languageModel: model,
      tools: { ask_human: tool({ inputSchema: z.object({ q: z.string() }) }) },
      executor,
      executableTools: ['eval_script'],
    })
    void runner.start()
    runner.sendMessage('go')

    await vi.waitFor(() => expect(runner.pendingToolCalls).toHaveLength(1))
    expect(dispatched).toEqual([])
    expect(runner.resolveToolCall('c1', { type: 'text', value: 'yes' })).toBe(true)
  })
})
