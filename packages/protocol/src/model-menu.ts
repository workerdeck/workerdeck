import type { ModelOption } from './index.ts'

export type ModelMenu = {
  main: ModelOption[]
  more: ModelOption[]
  defaultRow?: ModelOption
}

const VERSION = /[-\s]?\d+(?:[.-]\d+)*/g

// "Opus 5.5" and "Opus 4.7" share the line "opus", "GPT-6 Astra" and "GPT-5.6 Astra" share "gpt astra".
export function modelLine(model: ModelOption): string {
  return model.displayName.replace(VERSION, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function dropVariant(id: string): string {
  return id.replace(/\[.*\]$/, '')
}

export function modelMatches(model: ModelOption, id: string): boolean {
  const bare = dropVariant(id)
  return model.value === id || model.value === bare || (model.resolvedModel !== undefined && dropVariant(model.resolvedModel) === bare)
}

// The short list a picker opens on: the default model first, then the newest model of every other line, in catalog
// order (catalogs list each line newest first). `more` is every model; a picker offers it only when it adds rows.
export function modelMenu(models: readonly ModelOption[], defaultModel?: string): ModelMenu {
  const rows = models.filter((m) => m.value !== 'default')
  const defaultRow = defaultModel === undefined ? undefined : rows.find((m) => modelMatches(m, defaultModel))
  const seen = new Set<string>()
  const newest: ModelOption[] = []
  for (const row of rows) {
    const line = modelLine(row)
    if (!seen.has(line)) {
      seen.add(line)
      newest.push(row)
    }
  }
  const main = defaultRow ? [defaultRow, ...newest.filter((m) => m !== defaultRow)] : newest
  return { main, more: rows, defaultRow }
}

// The exact id a catalog row stands for: `opus` and `opus[1m]` become `claude-opus-5-5` and `claude-opus-5-5[1m]`. An
// id no row knows is already exact (a provider's own name), so it passes through.
export function exactModel(models: readonly ModelOption[], id: string): string {
  const row = models.find((m) => m.value !== 'default' && modelMatches(m, id))
  if (!row) {
    return id
  }
  const variant = /\[.*\]$/.exec(id)?.[0] ?? ''
  return dropVariant(row.resolvedModel ?? row.value) + variant
}
