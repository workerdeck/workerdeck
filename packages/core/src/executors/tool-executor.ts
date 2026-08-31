import type { ToolExecutionBackend } from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'

export type ToolExecutionResult =
  | { status: 'ok'; output: unknown; logs?: string[] }
  | { status: 'failed'; reason: string; error: string; logs?: string[] }

export type ToolExecutionCall = {
  executionId: string
  sessionId: string
  tool: string
  input: unknown
  vfs?: SandboxVfs
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  signal?: AbortSignal
}

export type ToolExecutionDispatch =
  | { executionId: string; status: 'settled'; result: ToolExecutionResult }
  | { executionId: string; status: 'pending' }

export type ToolExecutionProfile = {
  backend?: ToolExecutionBackend
  deferred?: boolean
  timeoutMs?: number
}

export interface ToolExecutor {
  describe?(call: ToolExecutionCall): ToolExecutionProfile
  dispatch(call: ToolExecutionCall): Promise<ToolExecutionDispatch>
}
