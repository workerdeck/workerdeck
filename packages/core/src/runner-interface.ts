import type { McpServerStatusInfo, PermissionMode, PermissionRequest, ProfileEngine, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import type { AttachmentInput } from './lib/attachments.ts'
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
  fail(message: string): void
  close(reason?: 'client' | 'server' | 'error'): void
}
