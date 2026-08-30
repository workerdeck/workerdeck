import type { LucideIcon } from 'lucide-react'
import type { PermissionMode } from '@workerdeck/protocol'
import { ClipboardList, Code, Hand, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export type PermissionModeMeta = {
  value: PermissionMode
  /** The name Claude Code itself uses. */
  label: string
  /** The chip form, for bars where the label shares a line with three other
   * things and "Bypass permissions" would eat half of it. */
  shortLabel: string
  /** What the mode actually does — the CLI's own one-liners. */
  description: string
  icon: LucideIcon
  dangerous?: boolean
}

/**
 * The modes surfaced across UI surfaces, ordered by how much of the approval
 * gate they give away. The wire value `default` is labelled **"Manual"** so it
 * cannot be read as "whatever the server picked". Naming, icons and summaries
 * are **shared with the iOS app** — the two surfaces must read as one list.
 */
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
    // Engine-neutral on purpose: claude's auto-mode classifier and codex's
    // `approvalsReviewer: 'auto_review'` are different mechanisms.
    description: 'The agent handles permission decisions',
    icon: Zap,
  },
  {
    value: 'dontAsk',
    label: "Don't ask",
    shortLabel: "Don't ask",
    // The CLI's own definition, and the opposite of bypass: it never prompts,
    // and anything not already permitted is denied rather than allowed.
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

export const permissionModeMeta = (mode: PermissionMode): PermissionModeMeta | undefined => PERMISSION_MODES.find((m) => m.value === mode)

/** One offered mode as plain data — no icon, no React. What a host chrome
 * outside the panel (a VS Code QuickPick) needs to draw the same list. */
export type PermissionModeChoice = {
  value: PermissionMode
  label: string
  description: string
  dangerous?: boolean
  /** Offered but unreachable: a session not started for bypass can never gain it. */
  disabled?: boolean
}

/** The modes this session may be switched into — the same filtering
 * {@link PermissionModeSelect} applies, so an embedder rendering its own picker
 * cannot drift from the panel's. */
export const permissionModeChoices = (modes?: readonly PermissionMode[], canBypass?: boolean): PermissionModeChoice[] => {
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
  /** The session's current mode (TranscriptState.permissionMode). */
  mode?: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  /** Restrict what is offered — most of {@link PERMISSION_MODES} is Claude Code
   * vocabulary the other engines have no meaning for. Defaults to all of them;
   * pass the session's `capabilities.permissionModes`. */
  modes?: readonly PermissionMode[]
  /**
   * Whether this session may be switched into `bypassPermissions` at all: the
   * CLI refuses unless the process was spawned for it. The row is shown
   * disabled rather than hidden. `undefined` (an older server) offers it.
   */
  canBypass?: boolean
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
