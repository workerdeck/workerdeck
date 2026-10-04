import type { ModelOption } from '@workerdeck/protocol'

export type EffortDefaults = Readonly<Record<string, string>>

export function effortDefaultFor(
  defaults: EffortDefaults | undefined,
  models: readonly ModelOption[] | undefined,
  ...names: Array<string | undefined>
): string | undefined {
  if (!defaults) {
    return undefined
  }
  const given = names.filter((name): name is string => !!name)
  const known = [...given, ...given.map((name) => name.replace(/\[.*\]$/, '')).filter((name) => !given.includes(name))]
  for (const name of known) {
    if (Object.hasOwn(defaults, name)) {
      return defaults[name]
    }
  }
  for (const row of models ?? []) {
    if (Object.hasOwn(defaults, row.value) && known.some((name) => name === row.resolvedModel)) {
      return defaults[row.value]
    }
  }
  return undefined
}

export function modelEfforts(models: readonly ModelOption[] | undefined, model: string | undefined): readonly string[] | undefined {
  if (!model) {
    return undefined
  }
  return models?.find((row) => row.value === model || row.resolvedModel === model)?.reasoningEfforts
}

export function assertEffort(effort: string | undefined, supported: readonly string[] | undefined): void {
  if (effort !== undefined && supported && !supported.includes(effort)) {
    throw new Error(`unsupported reasoning effort '${effort}' (supported: ${supported.join(', ') || 'none'})`)
  }
}
