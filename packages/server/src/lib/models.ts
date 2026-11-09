import type { EngineAdapter } from '@workerdeck/core'
import { exactModel, modelLine, modelMatches, type ModelOption, type ProfileInfo } from '@workerdeck/protocol'

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

// The static catalog plus the rows only this account reports (an access-gated model). A catalog row stays even when the
// account no longer lists it; an added row goes ahead of its line's newest so the picker's short list shows it.
export function withAccountModels(catalog: ModelOption[], live: readonly ModelOption[] | undefined): ModelOption[] {
  const added = (live ?? []).filter((row) => row.value !== 'default' && !catalog.some((known) => sameModel(known, row)))
  if (added.length === 0) {
    return catalog
  }
  const merged = [...catalog]
  for (const row of added) {
    const at = merged.findIndex((known) => modelLine(known) === modelLine(row))
    merged.splice(at === -1 ? merged.length : at, 0, row)
  }
  const lines = new Set<string>()
  return merged.map(({ primary: _primary, ...row }) => {
    const line = modelLine(row)
    const first = !lines.has(line)
    lines.add(line)
    return first ? { ...row, primary: true } : row
  })
}

function sameModel(a: ModelOption, b: ModelOption): boolean {
  return modelMatches(a, b.value) || (b.resolvedModel !== undefined && modelMatches(a, b.resolvedModel))
}
