import type { PermissionMode } from '@workerdeck/protocol'
import type { AppServerConnection } from './types.ts'

export type CodexWorkspaceWrite = {
  writableRoots: string[]
  networkAccess: boolean
  excludeTmpdirEnvVar: boolean
  excludeSlashTmp: boolean
}

export type CodexModePolicy = {
  approvalPolicy: object | undefined
  approvalsReviewer: string | undefined
}

const THREAD_SANDBOX_BY_MODE: Partial<Record<PermissionMode, string>> = {
  default: 'read-only',
  acceptEdits: 'workspace-write',
  auto: 'workspace-write',
  bypassPermissions: 'danger-full-access',
}

// Only `turnSandboxPolicy` may send the workspaceWrite entry: every unstated field of that
// variant is serde-defaulted, so a bare object resets the operator's networkAccess and
// writableRoots on every turn.
const TURN_SANDBOX_BY_MODE: Partial<Record<PermissionMode, { type: string }>> = {
  default: { type: 'readOnly' },
  acceptEdits: { type: 'workspaceWrite' },
  auto: { type: 'workspaceWrite' },
  bypassPermissions: { type: 'dangerFullAccess' },
}

const GRANULAR_ASK = {
  granular: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
    request_permissions: true,
    skill_approval: true,
  },
}

const GRANULAR_NEVER = {
  granular: {
    sandbox_approval: false,
    rules: false,
    mcp_elicitations: false,
    request_permissions: false,
    skill_approval: false,
  },
}

const APPROVAL_POLICY_BY_MODE: Partial<Record<PermissionMode, object>> = {
  default: GRANULAR_ASK,
  acceptEdits: GRANULAR_ASK,
  auto: GRANULAR_ASK,
  bypassPermissions: GRANULAR_NEVER,
}

const APPROVALS_REVIEWER_BY_MODE: Partial<Record<PermissionMode, string>> = {
  default: 'user',
  acceptEdits: 'user',
  auto: 'auto_review',
  bypassPermissions: 'user',
}

export const SHELL_WRITE_GATE_MODES: ReadonlySet<PermissionMode> = new Set(['default', 'acceptEdits'])

export function modePolicy(mode: PermissionMode): CodexModePolicy {
  return { approvalPolicy: APPROVAL_POLICY_BY_MODE[mode], approvalsReviewer: APPROVALS_REVIEWER_BY_MODE[mode] }
}

export function threadSandbox(mode: PermissionMode): string | undefined {
  return THREAD_SANDBOX_BY_MODE[mode]
}

export function turnSandboxPolicy(mode: PermissionMode, workspaceWrite: CodexWorkspaceWrite | undefined): { type: string } | undefined {
  const policy = TURN_SANDBOX_BY_MODE[mode]
  if (policy?.type !== 'workspaceWrite' || !workspaceWrite) {
    return policy
  }
  return { type: 'workspaceWrite', ...workspaceWrite }
}

export async function readWorkspaceWrite(connection: AppServerConnection, cwd: string): Promise<CodexWorkspaceWrite | undefined> {
  try {
    const result = (await connection.request('config/read', { cwd })) as {
      config?: { sandbox_workspace_write?: Record<string, unknown> | null } | null
    }
    const block = result?.config?.sandbox_workspace_write
    if (!block) {
      return undefined
    }
    const roots = block.writable_roots
    return {
      writableRoots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : [],
      networkAccess: block.network_access === true,
      excludeTmpdirEnvVar: block.exclude_tmpdir_env_var === true,
      excludeSlashTmp: block.exclude_slash_tmp === true,
    }
  } catch {
    return undefined
  }
}
