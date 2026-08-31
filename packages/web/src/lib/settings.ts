import type { ModelOption } from '@workerdeck/protocol'
import { readPref, writePref } from './storage.ts'

// Kept in sync by hand with the Claude Code CLI's model picker, and the fallback for a profile-less server only.
export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's configured default model" },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
]

export type DefaultsKind = 'session' | 'job'

export type TranscriptDensity = 'comfortable' | 'compact'

const DENSITY_KEY = 'workerdeck.transcript-density'

export function getTranscriptDensity(): TranscriptDensity {
  return readPref(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
}

export function setTranscriptDensity(density: TranscriptDensity): void {
  writePref(DENSITY_KEY, density)
}

export type TranscriptVariant = 'cards' | 'terminal'

const VARIANT_KEY = 'workerdeck.transcript-variant'

export function getTranscriptVariant(): TranscriptVariant {
  const stored = readPref(VARIANT_KEY)
  // `lines` was the retired no-boxes variant, and someone who turned boxes off keeps them off.
  return stored === 'terminal' || stored === 'lines' ? 'terminal' : 'cards'
}

export function setTranscriptVariant(variant: TranscriptVariant): void {
  writePref(VARIANT_KEY, variant)
}

export type TranscriptFont = 'sans' | 'mono'

const FONT_KEY = 'workerdeck.transcript-font'

export function getTranscriptFont(): TranscriptFont {
  return readPref(FONT_KEY) === 'mono' ? 'mono' : 'sans'
}

export function setTranscriptFont(font: TranscriptFont): void {
  writePref(FONT_KEY, font)
}

const FONT_SIZE_KEY = 'workerdeck.font-size'

export function getFontSize(): number | undefined {
  const raw = readPref(FONT_SIZE_KEY)
  if (raw === undefined) {
    return undefined
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 8 && n <= 24 ? Math.round(n) : undefined
}

export function setFontSize(size: number | undefined): void {
  writePref(FONT_SIZE_KEY, size === undefined ? undefined : String(Math.round(size)))
}
