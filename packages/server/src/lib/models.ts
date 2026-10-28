import type { EngineAdapter } from '@workerdeck/core'
import { exactModel, type ProfileInfo } from '@workerdeck/protocol'

// The exact model a session or agent runs: the one it asked for, else its profile's, else the engine's default. Never
// a short name (`opus` would move to the next release on its own) and never empty, so every record names one model.
export function modelFor(adapter: EngineAdapter, profile: ProfileInfo | undefined, id: string | undefined): string | undefined {
  const { models, defaultModel } = adapter.catalog
  const picked =
    named(id) ??
    named(profile?.defaults?.model) ??
    named(profile?.provider?.model) ??
    defaultModel ??
    models.find((m) => m.primary)?.value ??
    models[0]?.value
  return picked === undefined ? undefined : exactModel(models, picked)
}

// Blank and the CLI's `default` sentinel name no model: they take the default like an omitted one.
function named(id: string | undefined): string | undefined {
  const trimmed = id?.trim()
  return trimmed && trimmed !== 'default' ? trimmed : undefined
}
