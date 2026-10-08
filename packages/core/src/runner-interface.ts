import type {
  CreateSessionRequest,
  MessageOrigin,
  McpServerStatusInfo,
  PermissionMode,
  PermissionRequest,
  PricingTable,
  ProfileEngine,
  SessionEvent,
  SessionInfo,
  StatusLabel,
  StatusLabelInput,
} from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import type { AttachmentInput } from './lib/attachments.ts'
import type { AvatarDirectory } from './lib/avatar-tool.ts'
import type { ContextResetDirectory } from './lib/context-reset.ts'
import type { CostLedgerState } from './lib/cost-ledger.ts'
import type { SessionInstructions } from './lib/instructions.ts'
import type { LocalCommandResult, LocalShellSource } from './lib/local-command.ts'
import type { PeerDirectory, PeerMention } from './lib/peers.ts'
import type { ShellAgentWrite, ShellDirectory } from './lib/shells.ts'
import type { ToolExecutionResult } from './executors/tool-executor.ts'

export type SessionEventListener = (event: SessionEvent) => void

export type EngineRunnerConfig = CreateSessionRequest & {
  epoch?: number
  pricing?: PricingTable
  env?: Record<string, string | undefined>
  instructions?: SessionInstructions
  defaultApprovalTimeoutMs?: number | null
  peers?: PeerDirectory
  // Set by the gateway only on an agent's session where it draws avatars; its presence is what offers `change_avatar`.
  avatar?: AvatarDirectory
  // Set by the gateway only where the agent may reset its own context; its presence is what offers `context_reset`.
  contextReset?: ContextResetDirectory
  shells?: ShellDirectory
  shellAgentWrite?: ShellAgentWrite
  // Stamped by the gateway at create time from the principal that asked, and persisted with the record: the shell
  // write tools are offered only to a session an operator created.
  createdByOperator?: boolean
  // Stamped by the gateway at create time and persisted with the record; an agent's owner overrides it in `decorate`.
  owner?: string
  // The title a woken session last showed, ranked below the host's and the engine's, so it never freezes as a rename.
  fallbackTitle?: string
  // Set by the gateway on a dormant wake: the runner backfills, then waits for the first message to start its engine.
  startAsleep?: boolean
  effortDefaults?: Record<string, string>
  // The status label a woken session last showed; the event log takes over once it sees a set or a reset.
  statusLabel?: StatusLabel
}

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

export type SendMessageOptions = {
  origin?: MessageOrigin
  // Set only for a message a person typed, and only by the gateway's own send path: `origin` means
  // a model wrote this text, `mentions` means a human did, and the two are mutually exclusive.
  mentions?: readonly PeerMention[]
}

export type ClearContextOptions = { agentReason?: string }

export type SleepResult = { ok: true } | { ok: false; reason: string }

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
  sendMessage(text: string, attachments?: readonly AttachmentInput[], options?: SendMessageOptions): void
  queueLocalCommand?(input: LocalCommandResult | LocalShellSource): void
  // Re-reads the account's rate-limit windows and re-emits them as `rate_limit` events. Optional because only the
  // claude engine has a control request for it. Throttled by the implementation: an attach is a client's arrival,
  // not a reason to ask the CLI anything a second time within the minute.
  refreshUsage?(): Promise<void>
  mcpServers?(): Promise<McpServerStatusInfo[] | undefined>
  reconnectMcpServer?(name: string): Promise<void>
  setMcpServerEnabled?(name: string, enabled: boolean): Promise<void>
  setTitle(title: string | undefined): void
  // Null clears. Emits `status_label`; the label shows on `info().statusLabel`.
  setStatusLabel?(label: StatusLabelInput | null): StatusLabel | null
  resolvePermission(requestId: string, decision: PermissionDecision): boolean
  interrupt(): Promise<void>
  // Resolves false when the record has no stoppable background task (unknown, settled, or not the engine's to stop).
  stopTask?(toolUseId: string): Promise<boolean>
  // Ctrl+B: the blocking tool call returns at once and the task keeps running. No id backgrounds every foreground task.
  backgroundTask?(toolUseId?: string): Promise<boolean>
  clearContext?(options?: ClearContextOptions): Promise<void>
  // Stops the engine child while the session stays registered; the next message wakes it. Refused, never queued.
  sleep?(): Promise<SleepResult>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  setEffort?(effort?: string): Promise<void>
  // An owner rename on the gateway, never a transfer: the session keeps everything else.
  setOwner?(owner: string | undefined): void
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
