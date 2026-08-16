export { SessionRunner } from './engines/claude/runner.ts'
export { AiSdkRunner } from './engines/provider/runner.ts'
export type {
  AiSdkRunnerConfig,
  AiSdkSessionState,
  PendingToolCall,
  ToolCallOutput,
} from './engines/provider/runner.ts'
export type { HistoryFn, QueryFn, SessionRunnerConfig } from './engines/claude/runner.ts'
export { checkClaudeAuth, resolveBundledClaudeExecutable } from './engines/claude/auth.ts'
export type { ClaudeAuthProbe, ClaudeAuthStatus } from './engines/claude/auth.ts'
export type {
  ParkedExecution,
  PermissionDecision,
  Runner,
  RunnerSnapshot,
  SessionEventListener,
} from './runner-interface.ts'
export type {
  ToolExecutionCall,
  ToolExecutionDispatch,
  ToolExecutionResult,
  ToolExecutor,
} from './executors/tool-executor.ts'
export { QuickJsExecutor, isHostAllowed } from './executors/quickjs-executor.ts'
export type { HostFetch, QuickJsExecutorOptions } from './executors/quickjs-executor.ts'
export { BrowserBridgeExecutor, toExecutionResult } from './executors/browser-bridge-executor.ts'
export type { BridgeAnswer, BrowserBridgeExecutorOptions } from './executors/browser-bridge-executor.ts'
export { DeferredExecutor } from './executors/deferred-executor.ts'
export type { DeferredDispatch, DeferredExecutorOptions } from './executors/deferred-executor.ts'
export { connectMcpTools, createEngineSession } from './engines/provider/session.ts'
export type { EngineSessionOptions, McpConnection } from './engines/provider/session.ts'
/** Re-exported so a host wiring the provider engine can type its model factory
 * and tool sets without reaching past this package for the AI SDK itself —
 * `core` is the only package in the graph that depends on it. */
export type { LanguageModel, Tool, ToolSet } from 'ai'
export { createToolContext, withHostTools, withMcpTools } from './engines/provider/tools.ts'
export type {
  HostToolDefinition,
  ToolContext,
  ToolContextOptions,
  ToolDefinition,
  ToolTrust,
} from './engines/provider/tools.ts'
export { createWebFetch, htmlToMarkdown, isPrivateAddress } from './engines/provider/web-fetch.ts'
export type { WebFetchDigest, WebFetchFn, WebFetchOptions, WebFetchResult } from './engines/provider/web-fetch.ts'
export { PendingRequestRegistry } from './lib/pending-registry.ts'
export type {
  PendingEntry,
  PendingKind,
  PendingOutcome,
  RegisterOptions,
  SettledBy,
} from './lib/pending-registry.ts'
export { InputQueue } from './lib/input-queue.ts'
export {
  SUPPORTED_ATTACHMENT_TYPES,
  attachmentContentBlocks,
  attachmentKind,
  attachmentRef,
  normalizeMediaType,
} from './lib/attachments.ts'
export type { AttachmentInput, AttachmentKind } from './lib/attachments.ts'
export { mcpStatusInfo, modelOptionsFromSdk, normalizeSdkMessage, toApiMessage } from './lib/normalize.ts'
export { getEngineAdapter } from './engines/adapter.ts'
export type {
  EngineAdapter,
  EngineAvailability,
  EngineRunnerRequest,
  ModelCatalog,
} from './engines/adapter.ts'
export { claudeAdapter } from './engines/claude/adapter.ts'
export { CLAUDE_CATALOG } from './engines/claude/catalog.ts'
export { codexAdapter, listCodexSessions, resolveBundledCodexExecutable } from './engines/codex/adapter.ts'
export { CODEX_CATALOG } from './engines/codex/catalog.ts'
export { CodexRunner } from './engines/codex/runner.ts'
export type { CodexRunnerConfig } from './engines/codex/runner.ts'
export { connectAppServer } from './engines/codex/process.ts'
export { JsonRpcError, JsonRpcStdioConnection } from './engines/codex/jsonrpc.ts'
export type {
  AppServerConnection,
  AppServerConnectFn,
  AppServerConnectOptions,
  AppServerHistoryTurn,
  AppServerItem,
  AppServerThreadListResponse,
  AppServerThreadSummary,
  AppServerTokenUsage,
  AppServerTurn,
  AppServerUserInput,
} from './engines/codex/types.ts'
export { providerAdapter } from './engines/provider/adapter.ts'
