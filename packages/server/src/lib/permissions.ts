import { isJobRun, type PermissionMode, type ResolvePermissionRequest, type SessionInfo } from '@workerdeck/protocol'

export type PermissionModePolicy = { operator: boolean; disableBypass?: boolean }

export type PermissionDecisionInput = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
  interrupt?: boolean
}

export const OPERATOR_ONLY_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>(['bypassPermissions', 'dontAsk'])

export function refusePermissionMode(mode: PermissionMode | undefined, policy: PermissionModePolicy): string | null {
  if (mode === 'bypassPermissions' && policy.disableBypass) {
    return 'bypassPermissions is disabled on this server (disableBypassPermissions)'
  }
  if (!policy.operator && mode !== undefined && OPERATOR_ONLY_MODES.has(mode)) {
    return `permission mode '${mode}' is reserved to operators`
  }
  return null
}

export type BypassOption = boolean | 'sessions' | undefined

export function bypassDisabled(option: BypassOption, origin: { job?: boolean } = {}): boolean {
  return option === true || (option === 'sessions' && !origin.job)
}

export function refuseJobInput(info: SessionInfo, option: BypassOption): string | null {
  return option === 'sessions' && isJobRun(info) && info.permissionMode === 'bypassPermissions'
    ? 'this job runs in bypassPermissions; it takes no input until it ends'
    : null
}

export function permissionDecision(input: PermissionDecisionInput): ResolvePermissionRequest {
  return input.behavior === 'allow'
    ? { behavior: 'allow', updatedInput: input.updatedInput }
    : { behavior: 'deny', message: input.message, interrupt: input.interrupt }
}
