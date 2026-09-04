import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { tool } from 'ai'
import { z } from 'zod'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, type SandboxEngine } from '@workerdeck/sandbox'
import type { SessionEvent } from '@workerdeck/protocol'
import { QuickJsExecutor, connectMcpTools, createEngineSession, type McpConnection } from '../src/index.ts'
import { generateText, streamCall, streamText } from './helpers/ai-sdk-mocks.ts'
import type { ToolExecutionCall } from '../src/executors/tool-executor.ts'

let engine: SandboxEngine
beforeAll(async () => {
  engine = await loadEngine(variant)
})

describe('createEngineSession', () => {
  it('assembles a session that runs sandboxed tools through the selected executor', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [streamCall('c1', 'eval_script', { script: '6 * 7' }), streamText('42')],
    })
    const selectExecutor = vi.fn(() => new QuickJsExecutor({ engine }))
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor,
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('what is six times seven?')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    expect(selectExecutor).toHaveBeenCalled()
    expect(events.find((e) => e.type === 'execution_result')).toMatchObject({
      executionId: 'c1',
      output: { type: 'json', value: 42 },
    })
  }, 30_000)

  it('grants MCP tools as authoritative and runs them server-side', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [streamCall('c1', 'push', { lead: 'acme' }), streamText('pushed')],
    })
    const pushed: unknown[] = []
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
      mcpTools: {
        push: tool({
          inputSchema: z.object({ lead: z.string() }),
          execute: async (input) => {
            pushed.push(input)
            return { ok: true }
          },
        }),
      },
    })
    void runner.start()
    runner.sendMessage('push acme')
    await vi.waitFor(() => expect(pushed).toEqual([{ lead: 'acme' }]), { timeout: 15_000 })
  }, 30_000)

  it('emits file_delivered when the agent hands a VFS file over', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCall('c1', 'fs_write', { path: '/SUMMARY.md', content: '# Sum' }),
        streamCall('c2', 'deliver_file', { path: '/SUMMARY.md', description: 'the summary' }),
        streamText('Delivered.'),
      ],
    })
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('write and deliver a summary')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    expect(events.find((e) => e.type === 'file_delivered')).toMatchObject({
      path: '/SUMMARY.md',
      bytes: 5,
      description: 'the summary',
    })
    expect(runner.vfs?.read('/SUMMARY.md')).toBe('# Sum')
  }, 30_000)

  it('runs the web_fetch digest on the session model and bills it into the turn', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCall('c1', 'web_fetch', { url: 'http://203.0.113.5/pricing', prompt: 'how much?' }),
        streamText('The page says $10/mo.'),
      ],
      doGenerate: [generateText('It costs $10/mo.')],
    })
    const fetchImpl = async () =>
      new Response('<h1>Pricing</h1><p>$10/mo</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
      capabilities: { webFetch: { fetchImpl: fetchImpl as unknown as typeof fetch } },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('what does the pricing page say?')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    const turn = events.find((e) => e.type === 'turn_result')!
    expect(turn).toMatchObject({ subtype: 'success', result: 'The page says $10/mo.' })
    // Three model calls (loop step, digest, final step) at 10 in / 5 out each.
    expect(turn.type === 'turn_result' && turn.usage).toMatchObject({
      input_tokens: 30,
      output_tokens: 15,
    })
  }, 30_000)

  it('shares one scratch VFS between the tools and the sandbox', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        streamCall('c1', 'fs_write', { path: '/a.txt', content: 'hello' }),
        streamCall('c2', 'eval_script', { script: `vfs.read('/a.txt').toUpperCase()` }),
        streamText('done'),
      ],
    })
    const vfs = createVfs()
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model, vfs },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('go')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    expect(events.find((e) => e.type === 'execution_result')).toMatchObject({
      output: { type: 'json', value: 'HELLO' },
    })
  }, 30_000)
})

describe('createEngineSession grants', () => {
  const assemble = async (
    options: Omit<Parameters<typeof createEngineSession>[0], 'resolveModel' | 'selectExecutor' | 'config'> & {
      config?: Partial<Parameters<typeof createEngineSession>[0]['config']>
    },
  ) => {
    let toolNames: string[] = []
    let instructions: string | undefined
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: async (call) => {
        toolNames = (call.tools ?? []).map((t) => t.name).sort()
        instructions = call.prompt.find((m) => m.role === 'system')?.content
        return streamText('ok')
      },
    })
    const runner = createEngineSession({
      ...options,
      config: { cwd: '/tmp', ...options.config, languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
    })
    void runner.start()
    runner.sendMessage('go')
    await vi.waitFor(() => expect(toolNames.length).toBeGreaterThan(0), { timeout: 15_000 })
    runner.close()
    return { toolNames, instructions }
  }

  it('grants every wired backend when nothing declares otherwise', async () => {
    const { toolNames } = await assemble({
      capabilities: { webFetch: {}, search: async () => [], download: async () => ({ text: 'x' }) },
    })
    expect(toolNames).toContain('web_fetch')
    expect(toolNames).toContain('web_search')
    expect(toolNames).toContain('download')
    expect(toolNames).toContain('deliver_file')
  }, 30_000)

  it("withholds backends the profile's grant list leaves out", async () => {
    const { toolNames } = await assemble({
      profile: { name: 'p', engine: 'provider', session: { capabilities: ['web_fetch'] } },
      capabilities: { webFetch: {}, search: async () => [], download: async () => ({ text: 'x' }) },
    })
    expect(toolNames).toContain('web_fetch')
    expect(toolNames).not.toContain('web_search')
    expect(toolNames).not.toContain('download')
    expect(toolNames).not.toContain('deliver_file')
    expect(toolNames).toContain('eval_script')
    expect(toolNames).toContain('fs_write')
  }, 30_000)

  it('lets a session request narrow below what the profile grants', async () => {
    const { toolNames } = await assemble({
      profile: {
        name: 'p',
        engine: 'provider',
        session: { capabilities: ['web_fetch', 'deliver_file'] },
      },
      config: { capabilities: ['deliver_file'] },
      capabilities: { webFetch: {} },
    })
    expect(toolNames).toContain('deliver_file')
    expect(toolNames).not.toContain('web_fetch')
  }, 30_000)

  it('restricts MCP tools to the servers the profile names', async () => {
    const mcpTool = () => tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) })
    const { toolNames } = await assemble({
      profile: { name: 'p', engine: 'provider', session: { mcpServers: ['wiki'] } },
      mcpTools: { wiki__ask: mcpTool(), crm__push: mcpTool() },
    })
    expect(toolNames).toContain('wiki__ask')
    expect(toolNames).not.toContain('crm__push')
  }, 30_000)

  it("prefers the profile's instructions over the host's default", async () => {
    const { instructions } = await assemble({
      profile: { name: 'p', engine: 'provider', session: { instructions: 'You are terse.' } },
      instructions: 'host default',
    })
    expect(instructions).toBe('You are terse.')
  }, 30_000)
})

describe('createEngineSession host tools and MCP declarations', () => {
  const model = () => new MockLanguageModelV3({ modelId: 'mock-1', doStream: [streamText('ok')] })
  const build = (options: Partial<Parameters<typeof createEngineSession>[0]>) => {
    const m = model()
    return createEngineSession({
      config: { cwd: '/tmp', languageModel: m },
      resolveModel: () => m,
      selectExecutor: () => new QuickJsExecutor({ engine }),
      ...options,
    } as Parameters<typeof createEngineSession>[0])
  }
  const connected = (name: string): McpConnection => ({
    tools: {},
    servers: [{ name, status: 'connected' }],
    close: async () => {},
  })

  it('refuses to build when a declared MCP server never connected', () => {
    const mcp: McpConnection = {
      tools: {},
      servers: [{ name: 'wiki', status: 'failed', error: 'ECONNREFUSED' }],
      close: async () => {},
    }
    expect(() => build({ profile: { name: 'p', engine: 'provider', session: { mcpServers: ['wiki'] } }, mcp })).toThrow(
      /wiki \(ECONNREFUSED\)/,
    )
  })

  it('accepts a connected server that happens to expose no tools', () => {
    expect(() =>
      build({
        profile: { name: 'p', engine: 'provider', session: { mcpServers: ['wiki'] } },
        mcp: connected('wiki'),
      }),
    ).not.toThrow()
  })

  it('falls back to the namespace check when handed only a tool set', () => {
    const mcpTool = () => tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) })
    const profile = { name: 'p', engine: 'provider' as const, session: { mcpServers: ['wiki'] } }
    expect(() => build({ profile, mcpTools: { crm__push: mcpTool() } })).toThrow(/not connected/)
    expect(() => build({ profile, mcpTools: { wiki__ask: mcpTool() } })).not.toThrow()
  })

  it('reports only the MCP servers this profile was granted', async () => {
    const mcp: McpConnection = {
      tools: {},
      servers: [
        { name: 'wiki', status: 'connected' },
        { name: 'crm', status: 'connected' },
      ],
      close: async () => {},
    }
    const runner = build({
      profile: { name: 'p', engine: 'provider', session: { mcpServers: ['wiki'] } },
      mcp,
    })
    expect((await runner.mcpServers())?.map((s) => s.name)).toEqual(['wiki'])
  })

  it('publishes the titles a client cannot derive: what the host declared and what MCP reported', async () => {
    const runner = build({
      tools: {
        knowledge_upload: {
          trust: 'authoritative',
          title: 'Uploading knowledge',
          tool: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
        },
      },
      mcp: {
        tools: {},
        servers: [{ name: 'atomic', status: 'connected', tools: [{ name: 'AppContext', title: 'Reading the current page' }] }],
        close: async () => {},
      },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    expect(events.find((e) => e.type === 'tool_titles')).toMatchObject({
      titles: { knowledge_upload: 'Uploading knowledge', atomic__AppContext: 'Reading the current page' },
    })
  })

  it('says nothing about tools it has no title for, rather than inventing one', async () => {
    const events: SessionEvent[] = []
    const runner = build({})
    runner.subscribe((e) => events.push(e))
    void runner.start()
    expect(events.some((e) => e.type === 'tool_titles')).toBe(false)
  })

  it('answers with an empty list, not a 501, when no MCP was wired at all', async () => {
    expect(await build({}).mcpServers()).toEqual([])
  })

  it('runs a sandboxed host tool through the executor rather than in process', async () => {
    const dispatched: string[] = []
    const m = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [streamCall('c1', 'lookup', { q: 'acme' }), streamText('done')],
    })
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: m },
      resolveModel: () => m,
      selectExecutor: () => ({
        dispatch: async (call: ToolExecutionCall) => {
          dispatched.push(call.tool)
          return {
            executionId: call.executionId,
            status: 'settled' as const,
            result: { status: 'ok' as const, output: { hit: true } },
          }
        },
      }),
      tools: {
        lookup: { trust: 'sandboxed', tool: tool({ inputSchema: z.object({ q: z.string() }) }) },
      },
    })
    void runner.start()
    runner.sendMessage('go')
    await vi.waitFor(() => expect(dispatched).toEqual(['lookup']), { timeout: 15_000 })
    runner.close()
  }, 30_000)

  it('refuses a sandboxed tool that would run in this process anyway', () => {
    expect(() =>
      build({
        tools: {
          danger: {
            trust: 'sandboxed',
            tool: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
          },
        },
      }),
    ).toThrow(/declared sandboxed but has an `execute`/)
  })

  it('refuses an authoritative tool nothing would ever answer', () => {
    expect(() => build({ tools: { stuck: { trust: 'authoritative', tool: tool({ inputSchema: z.object({}) }) } } })).toThrow(/no `execute`/)
  })

  it('refuses a host tool that would shadow a built-in', () => {
    expect(() =>
      build({
        tools: {
          eval_script: {
            trust: 'authoritative',
            tool: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
          },
        },
      }),
    ).toThrow(/collides/)
  })
})

describe('createEngineSession rehydration', () => {
  const build = (options: Partial<Parameters<typeof createEngineSession>[0]>) => {
    const m = new MockLanguageModelV3({ modelId: 'mock-1', doStream: [streamText('ok')] })
    return createEngineSession({
      config: { cwd: '/tmp', languageModel: m },
      resolveModel: () => m,
      selectExecutor: () => new QuickJsExecutor({ engine }),
      ...options,
    } as Parameters<typeof createEngineSession>[0])
  }

  it('seeds the scratch filesystem for a new session', () => {
    const runner = build({ seedVfs: { '/README.md': 'hello' } })
    expect(runner.vfs?.read('/README.md')).toBe('hello')
  })

  it('ignores the seed on a restore, so a parked turn keeps what it wrote', () => {
    const snapshot = {
      engine: 'provider' as const,
      id: 'sess-1',
      createdAt: 1,
      seq: 0,
      events: [],
      vfs: { '/README.md': 'written by the parked turn' },
      parked: [],
      state: { messages: [], pendingToolCalls: [] },
    }
    const runner = build({ config: { cwd: '/tmp', restore: snapshot } as never, seedVfs: { '/README.md': 'hello' } })
    expect(runner.vfs?.read('/README.md')).toBe('written by the parked turn')
    expect(runner.id).toBe('sess-1')
  })

  it('adopts the id the gateway is rebuilding under', () => {
    expect(build({ id: 'sess-42' }).id).toBe('sess-42')
  })
})

describe('connectMcpTools', () => {
  it('is a no-op with no servers, so MCP stays an optional dependency', async () => {
    const connection = await connectMcpTools({})
    expect(connection.tools).toEqual({})
    await expect(connection.close()).resolves.toBeUndefined()
  })

  it('survives an unreachable server instead of failing the session', async () => {
    const errors: string[] = []
    const connection = await connectMcpTools(
      { broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      { onError: (name) => errors.push(name) },
    )
    expect(connection.tools).toEqual({})
    // onError may fire more than once per server: transport retries report through
    // onUncaughtError as well as the connect failure.
    expect(errors.length).toBeGreaterThan(0)
    expect(new Set(errors)).toEqual(new Set(['broken']))
  }, 20_000)

  it('reports every configured server, connected or not', async () => {
    const connection = await connectMcpTools({ broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }, { onError: () => {} })
    expect(connection.servers).toHaveLength(1)
    expect(connection.servers[0]).toMatchObject({
      name: 'broken',
      status: 'failed',
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
    })
    expect(connection.servers[0]!.error).toBeTruthy()
  }, 20_000)

  it("rejects with `required` — an embedder's own server failing is not a degraded session", async () => {
    await expect(connectMcpTools({ broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }, { required: true })).rejects.toThrow(
      /MCP server 'broken' failed to connect/,
    )
  }, 20_000)

  it('rejects stdio servers explicitly rather than dropping them silently', async () => {
    const errors: unknown[] = []
    await connectMcpTools({ local: { command: 'some-server' } }, { onError: (_name, error) => errors.push(error) })
    expect(String(errors[0])).toMatch(/stdio MCP servers are not supported/)
  })
})
