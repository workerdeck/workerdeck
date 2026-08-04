/**
 * Engine-aware create-form options. The two engines answer to different
 * vocabularies — `PermissionMode` is Claude Code's, and only the CLI can list its
 * own models — so the forms ask what the selected profile actually supports
 * rather than offering everything and letting the server refuse.
 */

import {
  PROVIDER_PERMISSION_MODES,
  supportsPermissionMode,
  type ModelOption,
  type PermissionMode,
  type ProfileInfo,
} from '@workerdeck/protocol'
import { MODEL_OPTIONS } from './settings.ts'

export type EngineFormOptions = {
  /** The profile runs the model-agnostic engine: no CLI affordances (resumable
   * SDK sessions, setting sources, the bypass pre-authorization). */
  isProvider: boolean
  /** Modes to offer; `undefined` = no restriction (Claude Code's full set). */
  modes: readonly PermissionMode[] | undefined
  /** Model rows to offer, led by a default sentinel row in both engines. */
  models: ModelOption[]
  /** The form's mode, coerced when this engine can't run the stored choice. */
  mode: PermissionMode
  /** The form's model, coerced to '' (= the profile's default) when off-list. */
  model: string
}

/**
 * Reconcile the form's stored choices with the selected profile. Both are sticky
 * across profile switches (localStorage), so a Claude alias or a CLI-only mode can
 * arrive at a provider profile — coerce rather than submit something the gateway
 * will reject.
 */
export function engineFormOptions(
  profile: ProfileInfo | undefined,
  mode: PermissionMode,
  model: string,
): EngineFormOptions {
  const isProvider = profile?.engine === 'provider'
  const safeMode = supportsPermissionMode(profile?.engine, mode) ? mode : 'default'
  if (!isProvider) {
    return { isProvider, modes: undefined, models: MODEL_OPTIONS, mode: safeMode, model }
  }
  // Provider engines have no `supportedModels()`: the list is what the operator
  // declared on the profile, falling back to its single default model.
  const provider = profile.provider
  const ids = provider?.models?.length ? provider.models : provider?.model ? [provider.model] : []
  return {
    isProvider,
    modes: PROVIDER_PERMISSION_MODES,
    models: [
      {
        value: 'default',
        displayName: 'Profile default',
        description: provider?.model ?? "the profile's configured model",
      },
      ...ids.map((id) => ({ value: id, displayName: id })),
    ],
    mode: safeMode,
    model: ids.includes(model) ? model : '',
  }
}
