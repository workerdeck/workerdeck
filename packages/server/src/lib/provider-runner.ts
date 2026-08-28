import {
  createEngineSession,
  type EngineSessionOptions,
  type HostToolDefinition,
  type LanguageModel,
  type McpConnection,
  type Runner,
  type ToolExecutionCall,
  type ToolExecutor,
  type ToolSet,
} from '@workerdeck/core'
import type { EngineRunnerContext } from '../options.ts'

export type ProviderRunnerOptions = {
  /**
   * The model to run. A function is called per turn with the session's
   * requested model id (undefined = the profile's default), which is what makes
   * the in-session model switcher work; a bare instance pins one model.
   */
  model: LanguageModel | ((modelId: string | undefined) => LanguageModel)
  /**
   * Where sandboxed tools (`eval_script` and any `sandboxed` entry in `tools`)
   * execute. This is a real architectural choice, not a default worth guessing
   * at, so it is required:
   *
   * - a {@link ToolExecutor} — an in-process guest (`new QuickJsExecutor(...)`
   *   from `@workerdeck/core`), which is right when the data the loop reasons
   *   over lives in this process. It is also the only option that works when no
   *   client is attached, which is every unattended job.
   * - `'browser'` — the attached tab, resolved per call from the bridge. Right
   *   when the data is *there* (a document the user is editing) and it should
   *   not travel to the gateway at all. Note the trade: it hands an executor to
   *   the party being sandboxed against, so its results are untrusted input.
   * - a **function** — selects per call, so `eval_script` can run in-process
   *   while a custom tool goes to the browser. The function receives the
   *   {@link ToolExecutionCall} and returns an executor or `'browser'`.
   */
  executor: ToolExecutor | 'browser' | ((call: ToolExecutionCall) => ToolExecutor | 'browser')
  /** Capability backends — the same shape {@link createEngineSession} takes.
   * Wiring one only offers it; the profile and request decide the grant. */
  capabilities?: EngineSessionOptions['capabilities']
  /** Host tools at explicit trust levels (`@workerdeck/core`'s `withHostTools`). */
  tools?: Record<string, HostToolDefinition>
  /** A live MCP connection from `connectMcpTools`. Prefer this over `mcpTools`:
   * it is what lets a profile's unhonoured `mcpServers` refuse the build, and
   * what makes `GET /sessions/:id/mcp` answer for this session. */
  mcp?: McpConnection
  /** A bare MCP tool set, for a host assembling one itself. */
  mcpTools?: ToolSet
  /** System-prompt addition, unless the profile declares its own. */
  instructions?: string
  /** Sandbox limits per execution. */
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /** Scratch-filesystem seed for a new session. Ignored on a rehydration, so a
   * parked turn's files are never overwritten. */
  seedVfs?: Record<string, string>
  /**
   * Gate tool execution behind user approval. See
   * {@link EngineSessionOptions.shouldApprove} — this is a straight pass-through.
   */
  shouldApprove?: (call: { toolName: string; input: unknown }) => boolean
  /** Timeout for permission prompts (ms). Default 120 000. */
  approvalTimeoutMs?: number
  /** Release per-session resources: the MCP connection, an issued token, a
   * watcher. Runs on close **and on park** — parking releases the same things. */
  onClose?: () => void | Promise<void>
}

/**
 * Build a provider-engine runner from the server's `createEngineRunner` context.
 *
 * `createEngineRunner` is a blank sheet: it hands you a context and wants a
 * `Runner`, and four of the five things a correct one must do are invisible in
 * the types — forward `restore`, adopt `id`, seed the VFS only when *not*
 * restoring, and dispose per-session resources. Each is a runtime-only failure
 * (a woken session that starts empty, a refused rebuild, an overwritten
 * filesystem, a connection leaked per session), and each is handled here.
 *
 * ```ts
 * createEngineRunner: (ctx) =>
 *   createProviderRunner(ctx, {
 *     model: (id) => openai(id ?? 'gpt-5.6-luna'),
 *     executor: quickjs,
 *     capabilities: { webFetch: {} },
 *     mcp,
 *     onClose: () => mcp.close(),
 *   }),
 * ```
 *
 * The hook itself stays open for anything this does not cover — this is the
 * 80% case, not a replacement for it.
 */
export async function createProviderRunner(
  ctx: EngineRunnerContext,
  options: ProviderRunnerOptions,
): Promise<Runner> {
  const { config, profile, bridge, restore, id } = ctx
  const resolveModel = (modelId: string | undefined): LanguageModel =>
    typeof options.model === 'function' ? options.model(modelId) : options.model
  // The runner's id does not exist at assembly time, so a bridged executor has
  // to be resolved per call from the call's own sessionId.
  const resolveBridged = (): ToolExecutor => ({
    dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
  })
  const resolveExecutor = (raw: ToolExecutor | 'browser'): ToolExecutor =>
    raw === 'browser' ? resolveBridged() : raw

  // Per-call executor: wrap into a per-call selectExecutor + backend so the
  // routing decision happens at dispatch time, not at session creation.
  const isPerCall = typeof options.executor === 'function'
  const selectExecutor: EngineSessionOptions['selectExecutor'] = isPerCall
    ? (call: ToolExecutionCall) =>
        resolveExecutor((options.executor as (call: ToolExecutionCall) => ToolExecutor | 'browser')(call))
    : () => resolveExecutor(options.executor as ToolExecutor | 'browser')
  const backend: EngineSessionOptions['backend'] = isPerCall
    ? (call: ToolExecutionCall) => {
        const raw = (options.executor as (call: ToolExecutionCall) => ToolExecutor | 'browser')(call)
        return raw === 'browser' ? 'browser' : 'server'
      }
    : options.executor === 'browser'
      ? 'browser'
      : 'server'

  return createEngineSession({
    config: {
      ...config,
      languageModel: resolveModel(config.model),
      // What makes a parked session come back as itself: same id, same event
      // log, same history, mid-task.
      restore,
      onClose: options.onClose,
    },
    // Set only when the gateway is rebuilding a session across a restart;
    // ignoring it strands every client's route and watermark.
    id,
    profile,
    resolveModel: (_profile, c) => resolveModel(c.model),
    selectExecutor,
    backend,
    capabilities: options.capabilities,
    tools: options.tools,
    mcp: options.mcp,
    mcpTools: options.mcpTools,
    instructions: options.instructions,
    executionLimits: options.executionLimits,
    shouldApprove: options.shouldApprove,
    approvalTimeoutMs: options.approvalTimeoutMs,
    seedVfs: options.seedVfs,
  })
}
