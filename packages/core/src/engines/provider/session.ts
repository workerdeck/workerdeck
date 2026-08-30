import type { LanguageModel, ToolSet } from 'ai'
import type { McpServerConfigWire, McpServerStatusInfo, McpServerToolInfo, ProfileInfo, SessionCapability } from '@workerdeck/protocol'
import { createVfs } from '@workerdeck/sandbox'
import { AiSdkRunner, type AiSdkRunnerConfig } from './runner.ts'
import { createToolContext, withHostTools, withMcpTools, type HostToolDefinition, type ToolContextOptions } from './tools.ts'
import type { ToolExecutionCall, ToolExecutionProfile, ToolExecutor } from '../../executors/tool-executor.ts'
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
   *
   * A function accepting a {@link ToolExecutionCall} selects **per call**:
   * `eval_script` may run on the in-process sandbox while a custom tool goes
   * to the browser, with no coupling between them.
   */
  selectExecutor: (() => ToolExecutor) | ((call: ToolExecutionCall) => ToolExecutor)
  /**
   * Which backend `selectExecutor` returned, for the `execution_dispatched`
   * events. A function returns the backend per call — pair it with a per-call
   * `selectExecutor` so the event matches the executor that actually ran.
   *
   * When `selectExecutor` is per-call and `backend` is static, every call is
   * reported under one label. When omitted, falls back to `'server'`.
   */
  backend?: 'server' | 'browser' | 'managed' | 'remote' | ((call: ToolExecutionCall) => 'server' | 'browser' | 'managed' | 'remote')
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
  /**
   * A live MCP connection from {@link connectMcpTools} — the preferred way to
   * hand MCP to a session, and the only one that can fail loudly.
   *
   * With this set, the session knows *which servers connected*, so two things
   * that were previously silent become impossible: a profile naming a server
   * that never connected refuses to build (see {@link mcpTools} for what that
   * used to look like), and `runner.mcpServers()` answers `GET
   * /sessions/:id/mcp` with the real per-server status instead of 501.
   */
  mcp?: McpConnection
  /** Authoritative tools that run server-side with server credentials (MCP).
   * Never bridged to a client. Namespaced `<server>__<tool>` by
   * {@link connectMcpTools}, which is how a profile grants servers by name.
   *
   * The bare tool set, for a host assembling one itself. Prefer {@link mcp}:
   * a tool set alone cannot distinguish "this server connected and exposes no
   * tools" from "this server never connected", so the check here has to be the
   * cruder one — a declared server contributing no tools is refused. */
  mcpTools?: ToolSet
  /**
   * Extra host tools, each at an explicit trust level (see
   * {@link withHostTools}). This is the seam for a tool that is neither one of
   * the built-in capabilities nor MCP — including a **sandboxed** one, which
   * `mcpTools` cannot express because everything in it is authoritative by
   * construction.
   *
   * A sandboxed tool here rides the same {@link ToolExecutor} seam
   * `eval_script` does, so it executes wherever `selectExecutor` points — an
   * in-process QuickJS guest, or the browser tab that asked the question.
   */
  tools?: Record<string, HostToolDefinition>
  /** Extra instructions prepended to the session's system prompt. Overridden by
   * the profile's `session.instructions` when it declares one. */
  instructions?: string
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /**
   * Gate tool execution behind user approval. When this returns `true` for a
   * given call and the session's permission mode is `'default'`, the runner
   * emits `permission_requested` and waits for the user to approve or deny
   * before dispatching. Bypass modes skip the check entirely.
   *
   * By default nothing requires approval — tools dispatch as soon as the model
   * calls them, which is the right call for trusted pipelines and the pre-§7
   * behavior.
   */
  shouldApprove?: (call: { toolName: string; input: unknown }) => boolean
  /** Timeout for permission prompts (ms). Default 120 000. */
  approvalTimeoutMs?: number
  /**
   * Initial scratch-filesystem contents for a **new** session, and the safe way
   * to seed one: it is ignored outright when `config.restore` is set, because a
   * rehydrated session brings back the files its parked turn already wrote and
   * seeding over them destroys exactly the work that was preserved.
   *
   * (Hand-building `config.vfs` still works and still wins — but then the
   * `restore ? undefined : createVfs(...)` dance is yours to get right.)
   */
  seedVfs?: Record<string, string>
  /**
   * Build the session under this id rather than minting one.
   *
   * Forward the server's `EngineRunnerContext.id` here, always: it is set when
   * the gateway is rehydrating a session across a restart, and a runner that
   * ignores it comes back as a *different* session — the rebuild is refused,
   * and every client's route and unread watermark is stranded. Ignored when
   * `config.restore` is present, which carries its own id.
   */
  id?: string
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
export const createEngineSession = (options: EngineSessionOptions): AiSdkRunner => {
  // A rehydrated session brings its scratch filesystem back with it — the
  // deliverables and working files the parked turn already produced. `seedVfs`
  // is for a *new* session only, which is the whole reason it exists here
  // rather than at each call site.
  const vfs = options.config.vfs ?? createVfs(options.config.restore ? options.config.restore.vfs : options.seedVfs)
  // Per-call executors: wrap the selector into a routing ToolExecutor so the
  // runner gets one interface. The selector's arity tells us which form it is:
  // 0-arg = the original "select once" call, 1-arg = per-call routing.
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
  // Narrowing only: the gateway has already refused a request naming a capability
  // its profile doesn't grant, so the request value wins when present.
  const granted = options.config.capabilities ?? options.profile?.session?.capabilities
  const isGranted = (key: keyof typeof CAPABILITY_TOOLS): boolean => granted === undefined || granted.includes(CAPABILITY_TOOLS[key])
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
      // Only the servers this profile was granted: the /mcp screen must not
      // report a connection the session cannot actually reach.
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

/**
 * Refuse to build a session whose profile names an MCP server that isn't there.
 *
 * A profile's `mcpServers` list is a **declaration**, not a filter: an embedder
 * who wrote it meant the agent to have those tools. Honouring it partially is
 * the worst failure mode this engine has — the session starts, reports healthy,
 * and the agent apologises its way through every request that needed the server,
 * with one warning line in a log nobody is reading.
 *
 * With a {@link McpConnection} the check is exact (did this server connect?).
 * With a bare tool set all we can see is whether any tool carries the server's
 * namespace, so a genuinely tool-less server would trip it — the fix there is to
 * pass `mcp` rather than to weaken this.
 */
const requireDeclaredServers = (
  profileName: string,
  declared: string[] | undefined,
  mcp: McpConnection | undefined,
  tools: ToolSet | undefined,
): void => {
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

/**
 * Restrict a connected tool set to the MCP servers a profile grants, by the
 * `<server>__<tool>` namespace {@link connectMcpTools} assigns. Undefined `servers`
 * = no declaration, so every connected server passes through.
 *
 * This is how one process-wide MCP connection serves a mixed fleet: the host
 * connects everything once, each profile grants a subset. The transport configs —
 * and any credentials in their headers — never leave the host for a profile.
 */
const selectMcpTools = (tools: ToolSet | undefined, servers: string[] | undefined): ToolSet | undefined => {
  if (!tools || servers === undefined) {
    return tools
  }
  const allowed = new Set(servers)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name.split('__')[0]!)))
}

export type McpConnection = {
  tools: ToolSet
  /**
   * One entry per configured server, connected or not — the truth a session was
   * assembled against. Handed to {@link createEngineSession} as `mcp`, it is
   * what `GET /sessions/:id/mcp` answers with and what makes a half-connected
   * session refuse to build rather than run degraded.
   */
  servers: McpServerStatusInfo[]
  close: () => Promise<void>
}

/**
 * Connect to MCP servers and return their tools, ready for {@link withMcpTools}.
 *
 * Server-side only, with server credentials: these tools are authoritative and
 * must never be bridged to a browser. `@ai-sdk/mcp` is imported lazily and is an
 * optional dependency — an operator who wires no MCP servers never needs it.
 *
 * **A stateless MCP server must answer `GET` with 405.** The client opens the
 * SSE stream with a `GET` before it sends anything, and a POST-only server
 * mounted under a framework's default 404 makes the whole connect fail with an
 * error that names neither the method nor the route. This is the single most
 * common way an otherwise-correct MCP mount fails.
 */
export const connectMcpTools = async (
  servers: Record<string, McpServerConfigWire>,
  options: {
    /** `onError` may fire more than once for a single server: transport-level
     * failures surface through the client's own uncaught-error channel as well as
     * the connect failure. Treat it as a report, not a count. */
    onError?: (name: string, error: unknown) => void
    /**
     * Reject if any server fails to connect, after closing the ones that did.
     *
     * Off by default, which is right for an operator's fleet — one unreachable
     * server should not take a whole gateway's sessions down. Turn it **on**
     * when the servers are the app's own: an embedder who mounts one wiki server
     * and gets a session without it has a session that cannot do its job, and
     * finding that out at connect time beats finding it out from a transcript
     * where the agent apologises.
     */
    required?: boolean
  } = {},
): Promise<McpConnection> => {
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
      // Namespaced so two servers exposing the same tool name cannot collide
      // (and so a tool's origin stays legible in the transcript).
      for (const [toolName, mcpTool] of Object.entries(connected)) {
        tools[`${name}__${toolName}`] = mcpTool as ToolSet[string]
      }
      statuses.push({
        name,
        status: 'connected',
        ...identity,
        // Unnamespaced here: this is the server's own view of itself, and the
        // `<server>__` prefix is this engine's routing detail.
        tools: Object.entries(connected).map(([toolName, mcpTool]) => toToolInfo(toolName, mcpTool)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      statuses.push({ name, status: 'failed', error: message, ...identity })
      options.onError?.(name, error)
      if (options.required) {
        // Nothing is half-open: the clients already connected are closed before
        // this leaves, or an embedder's failed create leaks a socket per attempt.
        await closeAll()
        throw new Error(`MCP server '${name}' failed to connect: ${message}`, { cause: error })
      }
      // Otherwise one unreachable server must not take down the session; the
      // agent simply does not get those tools.
    }
  }

  return { tools, servers: statuses, close: closeAll }
}

/** The connection's identity, minus its secrets — `headers` never travel. */
const describeServer = (server: McpServerConfigWire): Pick<McpServerStatusInfo, 'transport' | 'url' | 'command' | 'args'> => {
  if ('url' in server) {
    return { transport: server.type === 'sse' ? 'sse' : 'http', url: server.url }
  }
  return { transport: 'stdio', command: server.command, args: server.args }
}

/**
 * The AI SDK hands back its own `Tool`, whose `inputSchema` may be a zod schema
 * or a `jsonSchema()` wrapper. Only the latter carries a JSON Schema document,
 * so that is the only case where parameters are reported — `McpServerToolInfo`
 * models the absence deliberately, and inventing one here would be worse.
 */
const toToolInfo = (name: string, mcpTool: unknown): McpServerToolInfo => {
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

/**
 * Only http/sse: the AI SDK's built-in transports are the remote ones, and its
 * own docs mark stdio local-only and not deployable. A stdio server here is a
 * misconfiguration worth surfacing rather than silently dropping — the Claude
 * engine still supports stdio, since the CLI spawns those itself.
 */
const toTransport = (server: McpServerConfigWire) => {
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
