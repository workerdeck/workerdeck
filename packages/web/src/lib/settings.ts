/** Client-side preferences persisted in localStorage (see SettingsView). */

import type { ModelOption } from '@workerdeck/protocol'

/**
 * Static Claude alias rows, kept in sync with the Claude Code CLI's model picker.
 * The fallback for a profile-less server only — create forms serve the profile's
 * catalog (`ProfileInfo.models`), and a live session gets the CLI's own list.
 */
export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's configured default model" },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
]

/**
 * Which creation form we are filling. All that turns on it is the
 * `bypassPermissions` pre-authorization (the operator is present for one and not
 * the other) and the fallback permission mode; the configurable defaults live on
 * `ProfileInfo.defaults` so every client agrees on them.
 */
export type DefaultsKind = 'session' | 'job'

/**
 * How much air a session's rows get. Separate from the transcript *variant* on
 * purpose: the variant follows from the surface, this follows from the person.
 */
export type TranscriptDensity = 'comfortable' | 'compact'

const DENSITY_KEY = 'workerdeck.transcript-density'

export const getTranscriptDensity = (): TranscriptDensity => (localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable')

export const setTranscriptDensity = (density: TranscriptDensity): void => localStorage.setItem(DENSITY_KEY, density)

/**
 * Whether a session reads as chat or as a terminal. Independent of density:
 * density is how much air a *card* gets, and the terminal theme measures its own
 * spacing in blank lines.
 */
export type TranscriptVariant = 'cards' | 'terminal'

const VARIANT_KEY = 'workerdeck.transcript-variant'

export const getTranscriptVariant = (): TranscriptVariant => {
  const stored = localStorage.getItem(VARIANT_KEY)
  // `lines` was the retired no-boxes variant: someone who turned boxes off keeps them off.
  return stored === 'terminal' || stored === 'lines' ? 'terminal' : 'cards'
}

export const setTranscriptVariant = (variant: TranscriptVariant): void => localStorage.setItem(VARIANT_KEY, variant)

/**
 * The agent panel's typeface. `mono` applies to the **session panel alone** — the
 * chrome around it keeps the app's UI font, because the claim is a monospace agent
 * view inside an ordinary dashboard. `SessionPanel` scopes it with `data-agent-font`.
 */
export type TranscriptFont = 'sans' | 'mono'

const FONT_KEY = 'workerdeck.transcript-font'

export const getTranscriptFont = (): TranscriptFont => (localStorage.getItem(FONT_KEY) === 'mono' ? 'mono' : 'sans')

export const setTranscriptFont = (font: TranscriptFont): void => localStorage.setItem(FONT_KEY, font)

/**
 * Base font size for the agent panel, driving the scale of everything it draws in
 * both variants. `undefined` means platform default (13 px terminal, inherited
 * body for cards); non-numbers are treated as absent.
 */
const FONT_SIZE_KEY = 'workerdeck.font-size'

export const getFontSize = (): number | undefined => {
  const raw = localStorage.getItem(FONT_SIZE_KEY)
  if (raw === null) {
    return undefined
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 8 && n <= 24 ? Math.round(n) : undefined
}

export const setFontSize = (size: number | undefined): void => {
  if (size === undefined) {
    localStorage.removeItem(FONT_SIZE_KEY)
  } else {
    localStorage.setItem(FONT_SIZE_KEY, String(Math.round(size)))
  }
}
