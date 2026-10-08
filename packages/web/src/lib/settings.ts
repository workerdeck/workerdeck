import type { ModelOption } from '@workerdeck/protocol'
import type { TranscriptFont, TranscriptVariant } from '@workerdeck/ui'
import { readPref, writePref } from './storage.ts'

// Kept in sync by hand with the Claude Code CLI's model picker, and the fallback for a profile-less server only.
export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's configured default model" },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5.1 · For your toughest challenges' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · For complex work and everyday tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Most efficient for simpler tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
]

export type DefaultsKind = 'session' | 'job'

const VARIANT_KEY = 'workerdeck.transcript-variant'

export function getTranscriptVariant(): TranscriptVariant {
  return readPref(VARIANT_KEY) === 'terminal' ? 'terminal' : 'cards'
}

export function setTranscriptVariant(variant: TranscriptVariant): void {
  writePref(VARIANT_KEY, variant)
}

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

export type CatchUp = 'on' | 'off'

const CATCH_UP_KEY = 'workerdeck.catch-up'

export function getCatchUp(): CatchUp {
  return readPref(CATCH_UP_KEY) === 'off' ? 'off' : 'on'
}

export function setCatchUp(mode: CatchUp): void {
  writePref(CATCH_UP_KEY, mode)
}

export type ActionStyle = 'icons' | 'labeled'

const ACTION_STYLE_KEY = 'workerdeck.action-style'

export function getActionStyle(): ActionStyle {
  return readPref(ACTION_STYLE_KEY) === 'labeled' ? 'labeled' : 'icons'
}

export function setActionStyle(style: ActionStyle): void {
  writePref(ACTION_STYLE_KEY, style)
}

export type ThinkingPref = 'show' | 'hide'

const THINKING_KEY = 'workerdeck.thinking'

export function getThinking(): ThinkingPref {
  return readPref(THINKING_KEY) === 'hide' ? 'hide' : 'show'
}

export function setThinking(mode: ThinkingPref): void {
  writePref(THINKING_KEY, mode)
}
