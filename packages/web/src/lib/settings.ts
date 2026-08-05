/** Client-side preferences persisted in localStorage (see SettingsView). */

import type { ModelOption, PermissionMode } from '@workerdeck/protocol'
import { PERMISSION_MODES } from '@workerdeck/ui'

/** Pre-session model choices: aliases the CLI resolves to current model ids, mirroring
 * its supportedModels shape (a 'default' sentinel row first). Live sessions get the
 * CLI's own list via the capabilities event; forms and settings use this static one. */
// Copy kept in sync with the Claude Code CLI's model picker (see _docs/TODO.md).
/** Static Claude alias rows — the fallback for the profile-less settings
 * defaults only; create forms serve the profile's catalog (`ProfileInfo.models`). */
export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's configured default model" },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
]

/** Which creation form a default applies to: interactive sessions or queue jobs. */
export type DefaultsKind = 'session' | 'job'

const MODEL_KEYS: Record<DefaultsKind, string> = {
  session: 'workerdeck.default-session-model',
  job: 'workerdeck.default-job-model',
}

/** Default model pre-filled in the new-session / schedule-job forms. '' = CLI default. */
export function getDefaultModel(kind: DefaultsKind): string {
  return localStorage.getItem(MODEL_KEYS[kind]) ?? ''
}

export function setDefaultModel(kind: DefaultsKind, model: string): void {
  const trimmed = model.trim()
  if (trimmed) localStorage.setItem(MODEL_KEYS[kind], trimmed)
  else localStorage.removeItem(MODEL_KEYS[kind])
}

const PERMISSION_MODE_KEYS: Record<DefaultsKind, string> = {
  session: 'workerdeck.default-session-permission-mode',
  job: 'workerdeck.default-job-permission-mode',
}

/** Built-in fallbacks: interactive sessions ask by default; unattended jobs
 * auto-approve edits so they don't stall on every file write. */
const PERMISSION_MODE_FALLBACKS: Record<DefaultsKind, PermissionMode> = {
  session: 'default',
  job: 'acceptEdits',
}

/** Default permission mode pre-selected in the new-session / schedule-job forms. */
export function getDefaultPermissionMode(kind: DefaultsKind): PermissionMode {
  const stored = localStorage.getItem(PERMISSION_MODE_KEYS[kind])
  const valid = PERMISSION_MODES.some((m) => m.value === stored)
  return valid ? (stored as PermissionMode) : PERMISSION_MODE_FALLBACKS[kind]
}

export function setDefaultPermissionMode(kind: DefaultsKind, mode: PermissionMode): void {
  localStorage.setItem(PERMISSION_MODE_KEYS[kind], mode)
}
