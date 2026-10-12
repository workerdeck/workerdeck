import type { TranscriptState } from './transcript.ts'

export type Projection = { [key: string]: ProjectedValue }

export type ProjectedValue = string | number | boolean | null | ProjectedValue[] | Projection

const CATALOG_KEYS = new Set(['capabilities', 'session', 'models', 'commands', 'skills'])

export function projectTranscript(state: TranscriptState): Projection {
  const out: Projection = {}
  for (const key of Object.keys(state).sort()) {
    if (CATALOG_KEYS.has(key)) {
      continue
    }
    const value = canonical((state as Record<string, unknown>)[key])
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function canonical(value: unknown): ProjectedValue | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonical(entry) ?? null)
  }
  if (typeof value === 'object') {
    const out: Projection = {}
    for (const key of Object.keys(value).sort()) {
      const entry = canonical((value as Record<string, unknown>)[key])
      if (entry !== undefined) {
        out[key] = entry
      }
    }
    return out
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return undefined
}
