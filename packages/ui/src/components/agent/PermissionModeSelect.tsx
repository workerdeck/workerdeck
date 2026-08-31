import type { LucideIcon } from 'lucide-react'
import type { PermissionMode } from '@workerdeck/protocol'
import { ClipboardList, Code, Hand, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export type PermissionModeMeta = {
  value: PermissionMode
  label: string
  shortLabel: string
  description: string
  icon: LucideIcon
  dangerous?: boolean
}

export const PERMISSION_MODES: PermissionModeMeta[] = [
  {
    value: 'default',
    label: 'Manual',
    shortLabel: 'Manual',
    description: 'Always ask before making changes',
    icon: Hand,
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    shortLabel: 'Edits',
    description: 'Automatically accept all file edits',
    icon: Code,
  },
  {
    value: 'plan',
    label: 'Plan',
    shortLabel: 'Plan',
    description: 'Create a plan before making changes',
    icon: ClipboardList,
  },
  {
    value: 'auto',
    label: 'Auto',
    shortLabel: 'Auto',
    description: 'The agent handles permission decisions',
    icon: Zap,
  },
  {
    value: 'dontAsk',
    label: "Don't ask",
    shortLabel: "Don't ask",
    description: 'Never ask — deny anything not pre-approved',
    icon: ShieldCheck,
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    shortLabel: 'Bypass',
    description: 'Skip every approval — the agent is unsupervised',
    icon: TriangleAlert,
    dangerous: true,
  },
]

export function permissionModeMeta(mode: PermissionMode): PermissionModeMeta | undefined {
  return PERMISSION_MODES.find((m) => m.value === mode)
}

export type PermissionModeChoice = {
  value: PermissionMode
  label: string
  description: string
  dangerous?: boolean
  disabled?: boolean
}

export function permissionModeChoices(modes?: readonly PermissionMode[], canBypass?: boolean): PermissionModeChoice[] {
  const offered = modes ? PERMISSION_MODES.filter((m) => modes.includes(m.value)) : PERMISSION_MODES
  return offered.map((m) => ({
    value: m.value,
    label: m.label,
    description:
      m.value === 'bypassPermissions' && canBypass === false ? 'Only available to a session started in this mode' : m.description,
    dangerous: m.dangerous,
    disabled: m.value === 'bypassPermissions' && canBypass === false,
  }))
}

export interface PermissionModeSelectProps {
  mode?: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  modes?: readonly PermissionMode[]
  canBypass?: boolean
  variant?: 'toolbar' | 'form'
  disabled?: boolean
  className?: string
}

export function PermissionModeSelect({
  mode,
  onModeChange,
  modes,
  canBypass,
  variant = 'toolbar',
  disabled,
  className,
}: PermissionModeSelectProps) {
  const dangerous = mode === 'bypassPermissions'
  const offered = modes ? PERMISSION_MODES.filter((m) => modes.includes(m.value)) : PERMISSION_MODES
  const unavailable = (meta: PermissionModeMeta) => meta.value === 'bypassPermissions' && canBypass === false
  return (
    <Select
      items={offered.map((m) => ({ value: m.value, label: m.label }))}
      value={mode ?? null}
      onValueChange={(value) => {
        if (typeof value === 'string' && value !== mode) {
          onModeChange(value as PermissionMode)
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Permission mode"
        className={cn(
          variant === 'toolbar' && 'h-6 max-w-44 border-transparent bg-transparent hover:bg-surface-hover',
          dangerous ? 'text-danger' : variant === 'toolbar' ? 'text-fg-3' : undefined,
          className,
        )}
      >
        <span className={cn('truncate', variant === 'toolbar' && 'text-label')}>
          <SelectValue placeholder="permissions" />
        </span>
      </SelectTrigger>
      <SelectContent className="min-w-64">
        {offered.map((m) => {
          const blocked = unavailable(m)
          return (
            <SelectItem key={m.value} value={m.value} disabled={blocked}>
              <SelectItemText>
                <span className="flex items-center gap-2">
                  <m.icon className={cn('size-3.5 shrink-0', m.dangerous ? 'text-danger' : 'text-fg-3')} />
                  <span className={cn('font-medium', m.dangerous && 'text-danger')}>{m.label}</span>
                </span>
              </SelectItemText>
              <span className={cn('pl-5.5 text-label', blocked ? 'text-fg-4' : m.dangerous ? 'text-danger/80' : 'text-fg-4')}>
                {blocked ? 'Only available to a session started in this mode' : m.description}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
