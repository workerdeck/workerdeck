import { ENGINE_CAPABILITIES, modelMatches, type EngineCapabilities, type ModelOption, type PermissionMode, type ProfileInfo } from '@workerdeck/protocol'

export type EngineFormOptions = {
  capabilities: EngineCapabilities
  modes: readonly PermissionMode[]
  models: ModelOption[]
  defaultModel?: string
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
    rows = []
  }

  // Always a model the profile offers: the one picked, else the profile's default. Never empty, so a session never
  // leaves its model to the engine's own config.
  const find = (id: string | undefined) => (id ? rows.find((row) => modelMatches(row, id)) : undefined)
  // The id itself, not its row's value, so a variant (`[1m]`) survives.
  const chosen = find(model) ? model : find(defaultHint) ? defaultHint! : (rows[0]?.value ?? model)
  const matched = find(chosen)
  return {
    capabilities,
    modes: capabilities.permissionModes,
    models: rows,
    defaultModel: defaultHint,
    mode: safeMode,
    model: chosen,
    reasoningEfforts: (matched ? matched.reasoningEfforts : undefined) ?? capabilities.reasoningEfforts ?? [],
  }
}
