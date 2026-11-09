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
// account no longer lists it; an added row keeps its place in the account's newest-first order within its line.
export function withAccountModels(catalog: ModelOption[], live: readonly ModelOption[] | undefined): ModelOption[] {
  const rows = live ?? []
  const known = (row: ModelOption) => catalog.some((k) => sameModel(k, row))
  if (rows.every((row) => row.value === 'default' || known(row))) {
    return catalog
  }
  const merged = [...catalog]
  for (const [index, row] of rows.entries()) {
    if (row.value === 'default' || known(row)) {
      continue
    }
    const line = modelLine(row)
    const knownOfLine = (next: ModelOption) => modelLine(next) === line && known(next)
    const anchor = rows.slice(index + 1).find(knownOfLine) ?? (rows.slice(0, index).some(knownOfLine) ? undefined : catalog.find(knownOfLine))
    merged.splice(anchor ? merged.findIndex((m) => sameModel(m, anchor)) : afterLine(merged, line), 0, row)
  }
  const lines = new Set<string>()
  return merged.map(({ primary: _primary, ...row }) => {
    const line = modelLine(row)
    const first = !lines.has(line)
    lines.add(line)
    return first ? { ...row, primary: true } : row
  })
}

function afterLine(models: readonly ModelOption[], line: string): number {
  for (let i = models.length - 1; i >= 0; i -= 1) {
    if (modelLine(models[i]!) === line) {
      return i + 1
    }
  }
  return models.length
}

function sameModel(a: ModelOption, b: ModelOption): boolean {
  return modelMatches(a, b.value) || (b.resolvedModel !== undefined && modelMatches(a, b.resolvedModel))
}
