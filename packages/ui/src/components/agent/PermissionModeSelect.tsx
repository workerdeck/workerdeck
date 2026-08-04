import type { PermissionMode } from '@workerdeck/protocol'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export type PermissionModeMeta = {
  value: PermissionMode
  label: string
  description: string
  dangerous?: boolean
}

/** The modes surfaced across UI surfaces (session creation, in-session switcher). */
export const PERMISSION_MODES: PermissionModeMeta[] = [
  { value: 'default', label: 'default', description: 'ask for approval' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'auto-approve file edits' },
  { value: 'plan', label: 'plan', description: 'read-only planning' },
  { value: 'auto', label: 'auto', description: 'model decides when to ask' },
  { value: 'dontAsk', label: 'dontAsk', description: 'never ask — deny unapproved' },
  {
    value: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'no prompts (danger)',
    dangerous: true,
  },
]

export interface PermissionModeSelectProps {
  /** The session's current mode (TranscriptState.permissionMode). */
  mode?: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  /** Restrict what is offered — most of {@link PERMISSION_MODES} is Claude Code
   * vocabulary the provider engine has no meaning for. Defaults to all of them;
   * pass `PROVIDER_PERMISSION_MODES` for a provider session. */
  modes?: readonly PermissionMode[]
  /** 'toolbar' (default) is the composer's compact borderless trigger;
   * 'form' is a standard field-sized Select for create/settings forms. */
  variant?: 'toolbar' | 'form'
  disabled?: boolean
  className?: string
}

/** Permission-mode switcher: compact in the composer toolbar, field-sized in forms. */
export function PermissionModeSelect({
  mode,
  onModeChange,
  modes,
  variant = 'toolbar',
  disabled,
  className,
}: PermissionModeSelectProps) {
  const dangerous = mode === 'bypassPermissions'
  const offered = modes ? PERMISSION_MODES.filter((m) => modes.includes(m.value)) : PERMISSION_MODES
  return (
    <Select
      items={offered.map((m) => ({ value: m.value, label: m.label }))}
      value={mode ?? null}
      onValueChange={(value) => {
        if (typeof value === 'string' && value !== mode) onModeChange(value as PermissionMode)
      }}
      disabled={disabled}>
      <SelectTrigger
        aria-label='Permission mode'
        className={cn(
          variant === 'toolbar' &&
            'h-6 max-w-44 border-transparent bg-transparent hover:bg-surface-hover',
          dangerous ? 'text-danger' : variant === 'toolbar' ? 'text-fg-3' : undefined,
          className,
        )}>
        <span className={cn('truncate', variant === 'toolbar' && 'font-mono text-label')}>
          <SelectValue placeholder='permissions' />
        </span>
      </SelectTrigger>
      <SelectContent className='min-w-56'>
        {offered.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <SelectItemText>
              <span className={cn('font-medium', m.dangerous && 'text-danger')}>{m.label}</span>
            </SelectItemText>
            <span className={cn('text-label', m.dangerous ? 'text-danger/80' : 'text-fg-4')}>
              {m.description}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
