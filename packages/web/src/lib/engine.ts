import { ENGINE_CAPABILITIES, type EngineCapabilities, type ModelOption, type PermissionMode, type ProfileInfo } from '@workerdeck/protocol'
import { MODEL_OPTIONS } from './settings.ts'

export type EngineFormOptions = {
  capabilities: EngineCapabilities
  modes: readonly PermissionMode[]
  models: ModelOption[]
  mode: PermissionMode
  model: string
  // Empty means hide the control.
  reasoningEfforts: readonly string[]
}

// Derived from the profile's capability record and served catalog, never from the engine name. Both form choices are
// sticky across profile switches, so coerce them rather than submit something the gateway will reject.
export function engineFormOptions(profile: ProfileInfo | undefined, mode: PermissionMode, model: string): EngineFormOptions {
  const capabilities = profile?.capabilities ?? ENGINE_CAPABILITIES[profile?.engine ?? 'claude']
  const safeMode = capabilities.permissionModes.includes(mode) ? mode : capabilities.defaultPermissionMode

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
    reasoningEfforts: (matched ? matched.reasoningEfforts : undefined) ?? capabilities.reasoningEfforts ?? [],
  }
}
