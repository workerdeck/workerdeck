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
   * Where sandboxed tools (`eval_script`, and any `sandboxed` entry in `tools`) execute.
   * **Required, never defaulted** — an in-process {@link ToolExecutor} is the only option that
   * works with no client attached, `'browser'` hands an executor to the party being sandboxed
   * against, and a per-call function splits the difference. See `docs/PACKAGES.md`
   * §`packages/server`.
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
 * Build a provider-engine runner from a `createEngineRunner` context — the 80% case, never a
 * replacement for the hook. Four of the obligations a correct hook has are invisible in its types
 * and fail only at runtime, and all four are handled here: forward `restore`, adopt `id`, seed the
 * VFS only when *not* restoring, and dispose per-session resources.
 *
 * ```ts
 * createEngineRunner: (ctx) =>
 *   createProviderRunner(ctx, { model: (id) => openai(id ?? 'gpt-5.6-luna'), executor: quickjs, mcp, onClose: () => mcp.close() })
 * ```
 */
export const createProviderRunner = async (ctx: EngineRunnerContext, options: ProviderRunnerOptions): Promise<Runner> => {
  const { config, profile, bridge, restore, id } = ctx
  const resolveModel = (modelId: string | undefined): LanguageModel =>
    typeof options.model === 'function' ? options.model(modelId) : options.model
  // The runner's id does not exist at assembly time, so a bridged executor has
  // to be resolved per call from the call's own sessionId.
  const resolveBridged = (): ToolExecutor => ({
    dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
  })
  const resolveExecutor = (raw: ToolExecutor | 'browser'): ToolExecutor => (raw === 'browser' ? resolveBridged() : raw)

  // Per-call executor: wrap into a per-call selectExecutor + backend so the
  // routing decision happens at dispatch time, not at session creation.
  const isPerCall = typeof options.executor === 'function'
  const selectExecutor: EngineSessionOptions['selectExecutor'] = isPerCall
    ? (call: ToolExecutionCall) => resolveExecutor((options.executor as (call: ToolExecutionCall) => ToolExecutor | 'browser')(call))
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
