import type { LanguageModel, ToolSet } from 'ai'
import type { McpServerConfigWire, ProfileInfo, SessionCapability } from '@workerdeck/protocol'
import { createVfs } from '@workerdeck/sandbox'
import { AiSdkRunner, type AiSdkRunnerConfig } from './ai-sdk-runner.ts'
import { createToolContext, withMcpTools, type ToolContextOptions } from './tools.ts'
import type { ToolExecutor } from './tool-executor.ts'
import { createWebFetch, type WebFetchFn, type WebFetchOptions } from './web-fetch.ts'

export type EngineSessionOptions = {
  /** Resolved session config (profile defaults already applied). */
  config: AiSdkRunnerConfig
  /** The profile that selected this engine, when there was one. */
  profile?: ProfileInfo
  /**
   * Resolve the profile's provider config into a model instance. The host owns
   * this so core never imports a provider SDK and never reads credentials —
   * they come from the operator's environment, exactly like the Claude chain.
   */
  resolveModel: (profile: ProfileInfo | undefined, config: AiSdkRunnerConfig) => LanguageModel
  /**
   * Executor for sandboxed tools. Return the browser bridge when a client is
   * attached and the server sandbox otherwise; the seam makes them
   * interchangeable, so this is the only place the choice is made.
   */
  selectExecutor: () => ToolExecutor
  /** Which backend `selectExecutor` returned, for the execution_* events. */
  backend?: 'server' | 'browser' | 'managed' | 'remote'
  /** Backends for the granted capabilities. Omitted ones are simply not granted. */
  capabilities?: {
    search?: ToolContextOptions['search']
    download?: ToolContextOptions['download']
    /**
     * Grants `web_fetch`. Pass options (or `{}`) to use the built-in
     * {@link createWebFetch} backend — its digest pass then runs on the
     * session's own model, billed into the turn's usage. Pass `digest: false`
     * to skip the digest (the tool returns page markdown), a custom digest fn
     * to bring your own model, or a complete {@link WebFetchFn} to replace the
     * backend outright.
     */
    webFetch?: WebFetchFn | (Omit<WebFetchOptions, 'digest'> & { digest?: WebFetchOptions['digest'] | false })
    /** Grants `deliver_file`: the agent can hand VFS files over to the user
     * (emitting `file_delivered`, downloadable via the server's file routes).
     * Default true — set false to withhold it. */
    deliverFiles?: boolean
  }
  /** Authoritative tools that run server-side with server credentials (MCP).
   * Never bridged to a client. Namespaced `<server>__<tool>` by
   * {@link connectMcpTools}, which is how a profile grants servers by name. */
  mcpTools?: ToolSet
  /** Extra instructions prepended to the session's system prompt. Overridden by
   * the profile's `session.instructions` when it declares one. */
  instructions?: string
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
}

/** Which capability a wired backend yields, for grant filtering. */
const CAPABILITY_TOOLS = {
  search: 'web_search',
  download: 'download',
  webFetch: 'web_fetch',
  deliverFiles: 'deliver_file',
} as const satisfies Record<string, SessionCapability>

/**
 * Assemble a model-agnostic session: provider model, capability-scoped tools,
 * a scratch VFS, and the executor that runs the sandboxed ones.
 *
 * This is the piece an operator wires into the server's `createEngineRunner`.
 *
 * The host wires the *backends*; the profile and the session request decide which
 * of them are actually granted (`profile.session`, `config.capabilities`). A
 * backend that isn't granted is simply not built into the tool set, so withholding
 * a capability costs the host no branching. No declaration anywhere = everything
 * the host wired, which is what a host that ignores profiles gets.
 */
export function createEngineSession(options: EngineSessionOptions): AiSdkRunner {
  // A rehydrated session brings its scratch filesystem back with it — the
  // deliverables and working files the parked turn already produced.
  const vfs = options.config.vfs ?? createVfs(options.config.restore?.vfs)
  const executor = options.selectExecutor()
  // Narrowing only: the gateway has already refused a request naming a capability
  // its profile doesn't grant, so the request value wins when present.
  const granted = options.config.capabilities ?? options.profile?.session?.capabilities
  const isGranted = (key: keyof typeof CAPABILITY_TOOLS): boolean =>
    granted === undefined || granted.includes(CAPABILITY_TOOLS[key])
  // The runner doesn't exist yet while the tools are being built; these
  // capabilities reach back into it lazily (they only ever run mid-turn).
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
      options.capabilities?.deliverFiles === false || !isGranted('deliverFiles')
        ? undefined
        : (file) => runner?.emitFileDelivered(file),
  })
  const mcpTools = selectMcpTools(options.mcpTools, options.profile?.session?.mcpServers)
  const context = mcpTools ? withMcpTools(base, mcpTools) : base

  runner = new AiSdkRunner({
    ...options.config,
    languageModel: options.resolveModel(options.profile, options.config),
    instructions:
      options.profile?.session?.instructions ?? options.instructions ?? options.config.instructions,
    tools: context.tools,
    vfs,
    executor,
    executableTools: context.sandboxedToolNames,
    executionBackend: options.backend ?? 'server',
    executionLimits: options.executionLimits,
  })
  return runner
}

/**
 * Restrict a connected tool set to the MCP servers a profile grants, by the
 * `<server>__<tool>` namespace {@link connectMcpTools} assigns. Undefined `servers`
 * = no declaration, so every connected server passes through.
 *
 * This is how one process-wide MCP connection serves a mixed fleet: the host
 * connects everything once, each profile grants a subset. The transport configs —
 * and any credentials in their headers — never leave the host for a profile.
 */
function selectMcpTools(tools: ToolSet | undefined, servers: string[] | undefined): ToolSet | undefined {
  if (!tools || servers === undefined) return tools
  const allowed = new Set(servers)
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => allowed.has(name.split('__')[0]!)),
  )
}

export type McpConnection = {
  tools: ToolSet
  close: () => Promise<void>
}

/**
 * Connect to MCP servers and return their tools, ready for {@link withMcpTools}.
 *
 * Server-side only, with server credentials: these tools are authoritative and
 * must never be bridged to a browser. `@ai-sdk/mcp` is imported lazily and is an
 * optional dependency — an operator who wires no MCP servers never needs it.
 */
export async function connectMcpTools(
  servers: Record<string, McpServerConfigWire>,
  /** `onError` may fire more than once for a single server: transport-level
   * failures surface through the client's own uncaught-error channel as well as
   * the connect failure. Treat it as a report, not a count. */
  options: { onError?: (name: string, error: unknown) => void } = {},
): Promise<McpConnection> {
  const entries = Object.entries(servers)
  if (entries.length === 0) return { tools: {}, close: async () => {} }

  const { createMCPClient } = await import('@ai-sdk/mcp')
  const clients: Array<{ close: () => Promise<void> }> = []
  const tools: ToolSet = {}

  for (const [name, server] of entries) {
    try {
      const client = await createMCPClient({
        transport: toTransport(server),
        onUncaughtError: (error) => options.onError?.(name, error),
      })
      clients.push(client as unknown as { close: () => Promise<void> })
      // Namespaced so two servers exposing the same tool name cannot collide
      // (and so a tool's origin stays legible in the transcript).
      for (const [toolName, mcpTool] of Object.entries(await client.tools())) {
        tools[`${name}__${toolName}`] = mcpTool as ToolSet[string]
      }
    } catch (error) {
      // One unreachable server must not take down the session; the agent simply
      // does not get those tools.
      options.onError?.(name, error)
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()))
    },
  }
}

/**
 * Only http/sse: the AI SDK's built-in transports are the remote ones, and its
 * own docs mark stdio local-only and not deployable. A stdio server here is a
 * misconfiguration worth surfacing rather than silently dropping — the Claude
 * engine still supports stdio, since the CLI spawns those itself.
 */
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
