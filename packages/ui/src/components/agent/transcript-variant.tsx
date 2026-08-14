import { createContext, useContext, type ReactNode } from 'react'

/**
 * How the transcript draws a turn.
 *
 * - `cards` — the chat convention: bubbles, bordered tool cards, generous gaps.
 *   Right for a wide dashboard where the transcript is the page.
 * - `terminal` — the CLI's own form: every row on a character cell, no boxes
 *   anywhere, diffs as full-width bands. Right where the transcript sits beside
 *   a terminal (a VS Code dock) and where vertical space is scarce.
 *
 * `terminal` is **not** a second set of branches in the components under
 * `components/agent/`: it is its own renderer (`components/terminal/`) that the
 * shell mounts *instead* of them. So a row component here never asks which
 * variant it is in — if it is drawing at all, it is drawing cards.
 *
 * A context rather than a prop chain because the pieces that DO need it sit
 * outside the transcript (the composer, the pending prompts) and because
 * `Message`/`ToolCallCard` are exported on their own, so an embedder composing
 * them by hand gets the right treatment for free.
 */
export type TranscriptVariant = 'cards' | 'terminal'

const VariantContext = createContext<TranscriptVariant>('cards')

export function TranscriptVariantProvider({
  value,
  children,
}: {
  value: TranscriptVariant
  children: ReactNode
}) {
  return <VariantContext.Provider value={value}>{children}</VariantContext.Provider>
}

export function useTranscriptVariant(): TranscriptVariant {
  return useContext(VariantContext)
}

/**
 * How much room the transcript gives each row.
 *
 * - `comfortable` — a blank line between messages, which is what the Claude Code
 *   CLI does. The default: a transcript is prose before it is a table.
 * - `compact` — rows tight against each other, for a dock where every line of
 *   vertical space is contested.
 *
 * Separate from the variant, and deliberately: they answer different questions.
 * The variant decides *how a row is drawn* and follows from the surface; density
 * decides *how much air is around it* and is a preference the reader holds.
 *
 * Reaches `cards` only. The terminal theme's spacing is a blank *line*, decided
 * per pair of blocks by `needsBlank` — a terminal has one line height, which is
 * the whole premise — so there is nothing there for this to turn.
 */
export type TranscriptDensity = 'comfortable' | 'compact'

const DensityContext = createContext<TranscriptDensity>('comfortable')

export function TranscriptDensityProvider({
  value,
  children,
}: {
  value: TranscriptDensity
  children: ReactNode
}) {
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
}

export function useTranscriptDensity(): TranscriptDensity {
  return useContext(DensityContext)
}

/**
 * The typeface the panel runs in.
 *
 * `sans` is the host's UI font; `mono` repoints the sans token at the mono stack
 * for the panel's subtree (see the `[data-agent-font='mono']` rule in
 * `theme.css`), so the transcript reads as part of a terminal rather than as a
 * web app beside one.
 *
 * No context and no hook, unlike variant and density: nothing branches on it in
 * JS. It is one attribute on the panel root and the cascade does the rest, which
 * is also what keeps it from leaking past the panel.
 */
export type TranscriptFont = 'sans' | 'mono'

/**
 * The gap between two rows, per variant and density — the whole of the density
 * feature, since it is the only vertical spacing between rows that exists.
 *
 * `className` goes on the **measured** wrapper (see `Transcript`), so the gap is
 * part of each row's measured height and no pixel constant is load-bearing.
 * `px` is fed to `estimateSize` alone, where being approximate is the contract:
 * it sets the scrollbar's length before rows mount and is replaced by a real
 * measurement the moment one does.
 */
export const ROW_GAP: Record<
  TranscriptVariant,
  Record<TranscriptDensity, { className?: string; px: number }>
> = {
  // The terminal theme has no gap scale: the space between blocks is a **blank
  // line**, decided per pair by `needsBlank` (a tool call and its output get
  // none), so it is a class the shell applies conditionally rather than a
  // constant it applies to every row. Density does not reach it — a terminal
  // has one line height, which is the whole premise.
  terminal: {
    comfortable: { className: 'term-row-gap', px: 18 },
    compact: { className: 'term-row-gap', px: 18 },
  },
  cards: {
    comfortable: { className: 'pt-4', px: 16 },
    compact: { className: 'pt-2', px: 8 },
  },
}
