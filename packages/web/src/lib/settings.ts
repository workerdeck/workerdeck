/** Client-side preferences persisted in localStorage (see SettingsView). */

import type { ModelOption } from '@workerdeck/protocol'

/** Pre-session model choices: aliases the CLI resolves to current model ids, mirroring
 * its supportedModels shape (a 'default' sentinel row first). Live sessions get the
 * CLI's own list via the capabilities event; forms and settings use this static one. */
// Copy kept in sync with the Claude Code CLI's model picker.
/** Static Claude alias rows — the fallback for the profile-less settings
 * defaults only; create forms serve the profile's catalog (`ProfileInfo.models`). */
export const MODEL_OPTIONS: ModelOption[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's configured default model" },
  { value: 'fable', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks' },
  { value: 'opus', displayName: 'Opus', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
]

/**
 * Which creation form we are filling: an interactive session or a queue job.
 *
 * All that still turns on it is the `bypassPermissions` pre-authorization (the
 * operator is present for one and not the other) and the fallback permission
 * mode. The *configurable* defaults moved to the profile — model and permission
 * mode are `ProfileInfo.defaults`, which the gateway applies to any field a
 * create request leaves out, so every client agrees on them instead of each
 * browser holding its own.
 */
export type DefaultsKind = 'session' | 'job'

/**
 * Transcript density — how much air a session's rows get.
 *
 * A reader's preference, not a consequence of the surface: `comfortable` is what
 * the Claude Code CLI leaves (one blank line between rows), `compact` is for a
 * screen where vertical space is the scarce resource. Separate from the
 * transcript *variant* (boxed cards vs terminal lines) on purpose — the variant
 * follows from the surface, this follows from the person.
 */
export type TranscriptDensity = 'comfortable' | 'compact'

const DENSITY_KEY = 'workerdeck.transcript-density'

export function getTranscriptDensity(): TranscriptDensity {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
}

export function setTranscriptDensity(density: TranscriptDensity): void {
  localStorage.setItem(DENSITY_KEY, density)
}

/**
 * Transcript variant — whether a session reads as chat or as a terminal.
 *
 * `cards` is the chat convention and the dashboard's default; `terminal` is the
 * CLI's own form, every row on a character cell with no boxes anywhere.
 * Independent of density on purpose: density is how much air a *card* gets, and
 * the terminal theme measures its own spacing in blank lines.
 */
export type TranscriptVariant = 'cards' | 'terminal'

const VARIANT_KEY = 'workerdeck.transcript-variant'

export function getTranscriptVariant(): TranscriptVariant {
  const stored = localStorage.getItem(VARIANT_KEY)
  // `lines` was the retired no-boxes variant. Someone who turned boxes off keeps
  // them off — falling back to `cards` would silently undo the choice they made,
  // which is the one outcome a migration must not produce.
  return stored === 'terminal' || stored === 'lines' ? 'terminal' : 'cards'
}

export function setTranscriptVariant(variant: TranscriptVariant): void {
  localStorage.setItem(VARIANT_KEY, variant)
}

/**
 * The agent panel's typeface — the third reader preference beside variant and
 * density, and the same kind of thing.
 *
 * `mono` applies to the **session panel alone**: the sidebars, dialogs and lists
 * around it keep the app's UI font, because the claim is a monospace agent view
 * inside an ordinary dashboard, not a monospace dashboard. `SessionPanel` scopes
 * it with one `data-agent-font` attribute; see `ui`'s `theme.css`.
 */
export type TranscriptFont = 'sans' | 'mono'

const FONT_KEY = 'workerdeck.transcript-font'

export function getTranscriptFont(): TranscriptFont {
  return localStorage.getItem(FONT_KEY) === 'mono' ? 'mono' : 'sans'
}

export function setTranscriptFont(font: TranscriptFont): void {
  localStorage.setItem(FONT_KEY, font)
}

/**
 * Base font size for the agent panel — drives the overall scale of everything
 * the panel draws in both variants.
 *
 * `undefined` means platform default (13 px terminal, inherited body for cards).
 * Persisted as a plain integer; non-numbers are treated as absent.
 */
const FONT_SIZE_KEY = 'workerdeck.font-size'

export function getFontSize(): number | undefined {
  const raw = localStorage.getItem(FONT_SIZE_KEY)
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 8 && n <= 24 ? Math.round(n) : undefined
}

export function setFontSize(size: number | undefined): void {
  if (size === undefined) localStorage.removeItem(FONT_SIZE_KEY)
  else localStorage.setItem(FONT_SIZE_KEY, String(Math.round(size)))
}
