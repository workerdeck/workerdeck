import {
  createEngineSession,
  shellToolNeedsCard,
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
  const languageModel = typeof options.model === 'function' ? options.model(config.model) : options.model
  const executor = providerExecutor(options.executor, bridge)
  // Under `gated` the agent's shell write tools must raise a card even when the embedder wired no reviewer of its
  // own; `needsApproval` fires only through `shouldApprove`, so the default is supplied here and defers to the
  // embedder's for every other tool.
  const shouldApprove =
    config.shellAgentWrite === undefined
      ? options.shouldApprove
      : (call: { toolName: string; input: unknown }) =>
          shellToolNeedsCard(call.toolName, config.shellAgentWrite) || options.shouldApprove?.(call) === true
  return createEngineSession({
    config: {
      ...config,
      languageModel,
      ...(typeof options.model === 'function' && { resolveModel: options.model }),
      restore,
      onClose: options.onClose,
    },
    id,
    profile,
    resolveModel: () => languageModel,
    selectExecutor: () => executor,
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

// One executor, routed once per call, whose profile names the backend the call went to.
function providerExecutor(executor: ProviderRunnerOptions['executor'], bridge: EngineRunnerContext['bridge']): ToolExecutor {
  const bridged: ToolExecutor = { dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call) }
  if (typeof executor !== 'function') {
    return executor === 'browser' ? { ...bridged, describe: () => ({ backend: 'browser' }) } : executor
  }
  const route = (call: ToolExecutionCall): { target: ToolExecutor; backend: 'browser' | 'server' } => {
    const raw = executor(call)
    return raw === 'browser' ? { target: bridged, backend: 'browser' } : { target: raw, backend: 'server' }
  }
  return {
    describe: (call) => {
      const { target, backend } = route(call)
      return { ...target.describe?.(call), backend }
    },
    dispatch: (call) => route(call).target.dispatch(call),
  }
}
