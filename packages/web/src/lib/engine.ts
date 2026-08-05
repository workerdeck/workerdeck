/**
 * Engine-aware create-form options, derived from the profile's **capability
 * record** and served **model catalog** — never from the engine name. The
 * record answers "what can this form offer" (modes, resume browsing, CLI-only
 * sections, the effort control); the catalog answers "which models". Both are
 * stamped on `GET /profiles` from the first request; the protocol's
 * ENGINE_CAPABILITIES is the fallback for a server that predates the field.
 */

import {
  ENGINE_CAPABILITIES,
  type EngineCapabilities,
  type ModelOption,
  type PermissionMode,
  type ProfileInfo,
} from '@workerdeck/protocol'
import { MODEL_OPTIONS } from './settings.ts'

export type EngineFormOptions = {
  /** The record the form renders around (wire copy, else the static default). */
  capabilities: EngineCapabilities
  /** Modes to offer — always the record's list, never "everything". */
  modes: readonly PermissionMode[]
  /** Model rows to offer, led by a "Profile default" sentinel row. */
  models: ModelOption[]
  /** The form's mode, coerced to the record's default when this engine can't
   * run the stored choice. */
  mode: PermissionMode
  /** The form's model, coerced to '' (= the profile's default) when off-list. */
  model: string
  /** Reasoning efforts offerable for the chosen model; empty = hide the
   * control. Per-model when the catalog row declares them, else the engine's
   * record-level set. */
  reasoningEfforts: readonly string[]
}

/**
 * Reconcile the form's stored choices with the selected profile. Both are sticky
 * across profile switches (localStorage), so a Claude alias or a CLI-only mode can
 * arrive at any profile — coerce rather than submit something the gateway
 * will reject.
 */
export function engineFormOptions(
  profile: ProfileInfo | undefined,
  mode: PermissionMode,
  model: string,
): EngineFormOptions {
  const capabilities = profile?.capabilities ?? ENGINE_CAPABILITIES[profile?.engine ?? 'claude']
  const safeMode = capabilities.permissionModes.includes(mode)
    ? mode
    : capabilities.defaultPermissionMode

  // Rows: the server-stamped catalog when present (claude/codex — correct from
  // the first request); else the operator-declared provider ids; else the
  // static Claude fallback for a profile-less server.
  let rows: ModelOption[]
  let defaultHint: string | undefined
  if (profile?.models?.length) {
    rows = profile.models
    defaultHint = profile.defaultModel
  } else if (profile?.engine === 'provider') {
    const provider = profile.provider
    const ids = provider?.models?.length ? provider.models : provider?.model ? [provider.model] : []
    rows = ids.map((id) => ({ value: id, displayName: id }))
    defaultHint = provider?.model
  } else {
    rows = MODEL_OPTIONS.filter((option) => option.value !== 'default')
  }

  const matched = rows.find((row) => row.value === model || row.resolvedModel === model)
  const safeModel = matched || model === '' ? model : ''
  return {
    capabilities,
    modes: capabilities.permissionModes,
    models: [
      {
        value: 'default',
        displayName: 'Profile default',
        description: defaultHint ?? "the profile's configured model",
      },
      ...rows,
    ],
    mode: safeMode,
    model: safeModel,
    reasoningEfforts:
      (matched ? matched.reasoningEfforts : undefined) ?? capabilities.reasoningEfforts ?? [],
  }
}
