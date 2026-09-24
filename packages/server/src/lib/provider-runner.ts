import {
  createEngineSession,
  isShellWriteToolName,
  type EngineSessionOptions,
  type HostToolDefinition,
  type LanguageModel,
  type McpConnection,
  type SessionInstructions,
  type Runner,
  type ToolExecutionCall,
  type ToolExecutor,
  type ToolSet,
} from '@workerdeck/core'
import type { EngineRunnerContext } from '../options.ts'

export type ProviderRunnerOptions = {
  model: LanguageModel | ((modelId: string | undefined) => LanguageModel)
  executor: ToolExecutor | 'browser' | ((call: ToolExecutionCall) => ToolExecutor | 'browser')
  capabilities?: EngineSessionOptions['capabilities']
  tools?: Record<string, HostToolDefinition>
  mcp?: McpConnection
  mcpTools?: ToolSet
  instructions?: SessionInstructions
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
  seedVfs?: Record<string, string>
  shouldApprove?: (call: { toolName: string; input: unknown }) => boolean
  approvalTimeoutMs?: number | null
  // Runs on park as well as close: parking releases the same per-session resources.
  onClose?: () => void | Promise<void>
}

export async function createProviderRunner(ctx: EngineRunnerContext, options: ProviderRunnerOptions): Promise<Runner> {
  const { config, profile, bridge, restore, id } = ctx
  const resolveModel = (modelId: string | undefined): LanguageModel =>
    typeof options.model === 'function' ? options.model(modelId) : options.model
  const resolveBridged = (): ToolExecutor => ({
    dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
  })
  const resolveExecutor = (raw: ToolExecutor | 'browser'): ToolExecutor => (raw === 'browser' ? resolveBridged() : raw)

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

  // Under `gated` the agent's shell write tools must raise a card even when the embedder wired no reviewer of its
  // own; `needsApproval` fires only through `shouldApprove`, so the default is supplied here and defers to the
  // embedder's for every other tool.
  const shouldApprove =
    config.shellAgentWrite === 'gated'
      ? (call: { toolName: string; input: unknown }) => isShellWriteToolName(call.toolName) || options.shouldApprove?.(call) === true
      : options.shouldApprove
  return createEngineSession({
    config: {
      ...config,
      languageModel: resolveModel(config.model),
      restore,
      onClose: options.onClose,
    },
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
    shouldApprove,
    approvalTimeoutMs: config.defaultApprovalTimeoutMs === undefined ? options.approvalTimeoutMs : config.defaultApprovalTimeoutMs,
    seedVfs: options.seedVfs,
  })
}
