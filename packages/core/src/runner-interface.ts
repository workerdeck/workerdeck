import type { McpServerStatusInfo, PermissionMode, PermissionRequest, ProfileEngine, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import type { AttachmentInput } from './lib/attachments.ts'
import type { CostLedgerState } from './lib/cost-ledger.ts'
import type { LocalCommandResult } from './lib/local-command.ts'
import type { ToolExecutionResult } from './executors/tool-executor.ts'

export type SessionEventListener = (event: SessionEvent) => void

export type ParkedExecution = {
  executionId: string
  toolName: string
  expiresAt?: number
}

export type RunnerSnapshot = {
  engine: ProfileEngine
  id: string
  createdAt: number
  seq: number
  events: SessionEvent[]
  vfs?: Record<string, string>
  parked: ParkedExecution[]
  state: unknown
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

export interface Runner {
  readonly id: string
  readonly pendingApprovals: PermissionRequest[]
  readonly vfs?: SandboxVfs
  start(): Promise<void>
  info(): SessionInfo
  subscribe(
    listener: SessionEventListener,
    afterSeq?: number,
    options?: { coalesceReplay?: boolean; truncateResults?: boolean; imageRefs?: boolean },
  ): () => void
  eventAt?(seq: number): SessionEvent | undefined
  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void
  queueLocalCommand?(result: LocalCommandResult): void
  // Re-reads the account's rate-limit windows and re-emits them as `rate_limit` events. Optional because only the
  // claude engine has a control request for it. Throttled by the implementation: an attach is a client's arrival,
  // not a reason to ask the CLI anything a second time within the minute.
  refreshUsage?(): Promise<void>
  mcpServers?(): Promise<McpServerStatusInfo[] | undefined>
  reconnectMcpServer?(name: string): Promise<void>
  setMcpServerEnabled?(name: string, enabled: boolean): Promise<void>
  setTitle(title: string | undefined): void
  resolvePermission(requestId: string, decision: PermissionDecision): boolean
  interrupt(): Promise<void>
  clearContext?(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  settleExecution?(executionId: string, result: ToolExecutionResult): boolean
  park?(): RunnerSnapshot | undefined
  snapshot?(): RunnerSnapshot | undefined
  // A rebuilt engine process may count spend from zero or restore its own running total, and which one it did is
  // only knowable from the first reading it produces. `costState()` is what a park persists so the rebuild can tell
  // the restorable share from the rest; `carryCost` hands it back. Additive for codex and provider, reconciled for
  // claude - see `CostLedger`.
  carryCost?(state: CostLedgerState): void
  costState?(): CostLedgerState
  fail(message: string): void
  close(reason?: 'client' | 'server' | 'error'): void
}
