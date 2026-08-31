import type { LanguageModel, ToolSet } from 'ai'
import type { McpServerConfigWire, McpServerStatusInfo, McpServerToolInfo, ProfileInfo, SessionCapability } from '@workerdeck/protocol'
import { createVfs } from '@workerdeck/sandbox'
import { AiSdkRunner, type AiSdkRunnerConfig } from './runner.ts'
import { createToolContext, withHostTools, withMcpTools, type HostToolDefinition, type ToolContextOptions } from './tools.ts'
import type { ToolExecutionCall, ToolExecutionProfile, ToolExecutor } from '../../executors/tool-executor.ts'
import { createWebFetch, type WebFetchFn, type WebFetchOptions } from './web-fetch.ts'

export type EngineSessionOptions = {
  config: AiSdkRunnerConfig
  profile?: ProfileInfo
  resolveModel: (profile: ProfileInfo | undefined, config: AiSdkRunnerConfig) => LanguageModel
  selectExecutor: (() => ToolExecutor) | ((call: ToolExecutionCall) => ToolExecutor)
  backend?: 'server' | 'browser' | 'managed' | 'remote' | ((call: ToolExecutionCall) => 'server' | 'browser' | 'managed' | 'remote')
  capabilities?: {
    search?: ToolContextOptions['search']
    download?: ToolContextOptions['download']
    webFetch?: WebFetchFn | (Omit<WebFetchOptions, 'digest'> & { digest?: WebFetchOptions['digest'] | false })
    deliverFiles?: boolean
  }
  mcp?: McpConnection
  mcpTools?: ToolSet
  tools?: Record<string, HostToolDefinition>
  instructions?: string
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  shouldApprove?: (call: { toolName: string; input: unknown }) => boolean
  approvalTimeoutMs?: number
  seedVfs?: Record<string, string>
  id?: string
}

const CAPABILITY_TOOLS = {
  search: 'web_search',
  download: 'download',
  webFetch: 'web_fetch',
  deliverFiles: 'deliver_file',
} as const satisfies Record<string, SessionCapability>

export function createEngineSession(options: EngineSessionOptions): AiSdkRunner {
  const vfs = options.config.vfs ?? createVfs(options.config.restore ? options.config.restore.vfs : options.seedVfs)
  // The selector's arity picks the form: 0-arg selects once, 1-arg routes per call.
  const isPerCall = options.selectExecutor.length > 0
  const executor: ToolExecutor = isPerCall
    ? {
        describe(call: ToolExecutionCall): ToolExecutionProfile {
          const target = (options.selectExecutor as (call: ToolExecutionCall) => ToolExecutor)(call)
          const backend = typeof options.backend === 'function' ? options.backend(call) : options.backend
          return { ...target.describe?.(call), ...(backend ? { backend } : {}) }
        },
        dispatch(call: ToolExecutionCall) {
          const target = (options.selectExecutor as (call: ToolExecutionCall) => ToolExecutor)(call)
          return target.dispatch(call)
        },
      }
    : (options.selectExecutor as () => ToolExecutor)()
  // The request value wins only because the gateway already 400s a request that widens the
  // profile's grants; a host calling this directly owes that check itself.
  const granted = options.config.capabilities ?? options.profile?.session?.capabilities
  const isGranted = (key: keyof typeof CAPABILITY_TOOLS): boolean => granted === undefined || granted.includes(CAPABILITY_TOOLS[key])
  // The runner does not exist yet while the tools are built; the capabilities below reach back
  // into it lazily, and only ever run mid-turn.
  let runner: AiSdkRunner | undefined
  const webFetchCap = isGranted('webFetch') ? options.capabilities?.webFetch : undefined
  const webFetch =
    typeof webFetchCap === 'function'
      ? webFetchCap
      : webFetchCap
        ? createWebFetch({
            ...webFetchCap,
            digest:
              webFetchCap.digest === false
                ? undefined
                : (webFetchCap.digest ??
                  ((markdown, prompt) =>
                    runner!.generateDigest(
                      'Answer the request below using ONLY this web page content.\n\n' +
                        `<page>\n${markdown}\n</page>\n\nRequest: ${prompt}`,
                    ))),
          })
        : undefined
  const base = createToolContext({
    executor,
    sessionId: 'pending',
    vfs,
    search: isGranted('search') ? options.capabilities?.search : undefined,
    download: isGranted('download') ? options.capabilities?.download : undefined,
    webFetch,
    onFileDelivered:
      options.capabilities?.deliverFiles === false || !isGranted('deliverFiles') ? undefined : (file) => runner?.emitFileDelivered(file),
  })
  const declaredServers = options.profile?.session?.mcpServers
  const connected = options.mcp?.tools ?? options.mcpTools
  requireDeclaredServers(options.profile?.name ?? '(unnamed)', declaredServers, options.mcp, connected)
  const mcpTools = selectMcpTools(connected, declaredServers)
  const withMcp = mcpTools ? withMcpTools(base, mcpTools) : base
  const context = options.tools ? withHostTools(withMcp, options.tools) : withMcp

  runner = new AiSdkRunner(
    {
      ...options.config,
      languageModel: options.resolveModel(options.profile, options.config),
      instructions: options.profile?.session?.instructions ?? options.instructions ?? options.config.instructions,
      tools: context.tools,
      vfs,
      executor,
      executableTools: context.sandboxedToolNames,
      executionBackend: typeof options.backend === 'function' ? undefined : (options.backend ?? 'server'),
      executionLimits: options.executionLimits,
      shouldApprove: options.shouldApprove,
      approvalTimeoutMs: options.approvalTimeoutMs,
      reportMcpServers: options.mcp
        ? () =>
            Promise.resolve(
              declaredServers === undefined ? options.mcp!.servers : options.mcp!.servers.filter((s) => declaredServers.includes(s.name)),
            )
        : undefined,
    },
    options.id,
  )
  return runner
}

function requireDeclaredServers(
  profileName: string,
  declared: string[] | undefined,
  mcp: McpConnection | undefined,
  tools: ToolSet | undefined,
): void {
  if (!declared || declared.length === 0) {
    return
  }
  const missing = declared.filter((name) => {
    if (mcp) {
      const server = mcp.servers.find((s) => s.name === name)
      return !server || server.status !== 'connected'
    }
    return !Object.keys(tools ?? {}).some((tool) => tool.split('__')[0] === name)
  })
  if (missing.length === 0) {
    return
  }
  const reasons = missing
    .map((name) => {
      const error = mcp?.servers.find((s) => s.name === name)?.error
      return error ? `${name} (${error})` : name
    })
    .join(', ')
  throw new Error(
    `profile '${profileName}' declares MCP server(s) that are not connected: ${reasons}. ` +
      'A session missing a declared server is a session whose agent silently cannot do its job.',
  )
}

function selectMcpTools(tools: ToolSet | undefined, servers: string[] | undefined): ToolSet | undefined {
  if (!tools || servers === undefined) {
    return tools
  }
  const allowed = new Set(servers)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name.split('__')[0]!)))
}

export type McpConnection = {
  tools: ToolSet
  servers: McpServerStatusInfo[]
  close: () => Promise<void>
}

export async function connectMcpTools(
  servers: Record<string, McpServerConfigWire>,
  options: {
    // May fire more than once per server: a transport failure surfaces through the client's
    // uncaught-error channel as well as the connect failure.
    onError?: (name: string, error: unknown) => void
    required?: boolean
  } = {},
): Promise<McpConnection> {
  const entries = Object.entries(servers)
  if (entries.length === 0) {
    return { tools: {}, servers: [], close: async () => {} }
  }

  const { createMCPClient } = await import('@ai-sdk/mcp')
  const clients: Array<{ close: () => Promise<void> }> = []
  const tools: ToolSet = {}
  const statuses: McpServerStatusInfo[] = []
  const closeAll = async (): Promise<void> => {
    await Promise.allSettled(clients.map((c) => c.close()))
  }

  for (const [name, server] of entries) {
    const identity = describeServer(server)
    try {
      const client = await createMCPClient({
        transport: toTransport(server),
        onUncaughtError: (error) => options.onError?.(name, error),
      })
      clients.push(client as unknown as { close: () => Promise<void> })
      const connected = await client.tools()
      for (const [toolName, mcpTool] of Object.entries(connected)) {
        tools[`${name}__${toolName}`] = mcpTool as ToolSet[string]
      }
      statuses.push({
        name,
        status: 'connected',
        ...identity,
        // Unnamespaced: this is the server's own view of itself, and `<server>__` is routing.
        tools: Object.entries(connected).map(([toolName, mcpTool]) => toToolInfo(toolName, mcpTool)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      statuses.push({ name, status: 'failed', error: message, ...identity })
      options.onError?.(name, error)
      if (options.required) {
        await closeAll()
        throw new Error(`MCP server '${name}' failed to connect: ${message}`, { cause: error })
      }
    }
  }

  return { tools, servers: statuses, close: closeAll }
}

// Identity minus secrets: `headers` must never travel.
function describeServer(server: McpServerConfigWire): Pick<McpServerStatusInfo, 'transport' | 'url' | 'command' | 'args'> {
  if ('url' in server) {
    return { transport: server.type === 'sse' ? 'sse' : 'http', url: server.url }
  }
  return { transport: 'stdio', command: server.command, args: server.args }
}

// A zod `inputSchema` carries no JSON Schema document; only a `jsonSchema()` wrapper does, so
// that is the only case parameters are reported.
function toToolInfo(name: string, mcpTool: unknown): McpServerToolInfo {
  const { description, inputSchema } = (mcpTool ?? {}) as {
    description?: unknown
    inputSchema?: { jsonSchema?: unknown }
  }
  return {
    name,
    description: typeof description === 'string' ? description : undefined,
    inputSchema: inputSchema?.jsonSchema,
  }
}

function toTransport(server: McpServerConfigWire) {
  if (!('url' in server)) {
    throw new Error(
      'stdio MCP servers are not supported by the model-agnostic engine (use an http or sse ' +
        'server, or run this session under a Claude profile)',
    )
  }
  return server.type === 'sse'
    ? { type: 'sse' as const, url: server.url, headers: server.headers }
    : { type: 'http' as const, url: server.url, headers: server.headers }
}
