import { createContext, useContext, type ReactNode } from 'react'

/**
 * How the transcript draws a turn: `cards` (the chat convention) or `terminal`
 * (the CLI's own form).
 *
 * `terminal` is **not** a second set of branches in `components/agent/`: it is
 * its own renderer (`components/terminal/`) that the shell mounts *instead* of
 * them, so a row component here never asks which variant it is in. The context
 * exists for the pieces outside the transcript that do need it (the composer,
 * the pending prompts).
 */
export type TranscriptVariant = 'cards' | 'terminal'

const VariantContext = createContext<TranscriptVariant>('cards')

export function TranscriptVariantProvider({ value, children }: { value: TranscriptVariant; children: ReactNode }) {
  return <VariantContext.Provider value={value}>{children}</VariantContext.Provider>
}

export function useTranscriptVariant(): TranscriptVariant {
  return useContext(VariantContext)
}

/**
 * How much room the transcript gives each row. Separate from the variant: that
 * follows from the surface, this is a reader's preference.
 *
 * Reaches `cards` only — the terminal theme's spacing is a blank *line*, decided
 * per pair of blocks by `needsBlank`.
 */
export type TranscriptDensity = 'comfortable' | 'compact'

const DensityContext = createContext<TranscriptDensity>('comfortable')

export function TranscriptDensityProvider({ value, children }: { value: TranscriptDensity; children: ReactNode }) {
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
}

export function useTranscriptDensity(): TranscriptDensity {
  return useContext(DensityContext)
}

/**
 * The typeface the panel runs in. `mono` repoints the sans token at the mono
 * stack for the panel's subtree (`[data-agent-font='mono']` in `theme.css`).
 * No context and no hook: it is one attribute on the panel root and the cascade
 * does the rest, which is what keeps it from leaking past the panel.
 */
export type TranscriptFont = 'sans' | 'mono'

/**
 * The gap between two rows, per variant and density.
 *
 * `className` goes on the **measured** wrapper (see `Transcript`), so the gap is
 * part of each row's measured height and no pixel constant is load-bearing.
 * `px` feeds `estimateSize` alone, where being approximate is the contract.
 */
export const ROW_GAP: Record<TranscriptVariant, Record<TranscriptDensity, { className?: string; px: number }>> = {
  // The terminal theme has no gap scale: the space between blocks is a blank
  // line the shell applies conditionally, and density does not reach it.
  terminal: {
    comfortable: { className: 'term-row-gap', px: 18 },
    compact: { className: 'term-row-gap', px: 18 },
  },
  cards: {
    comfortable: { className: 'pt-4', px: 16 },
    compact: { className: 'pt-2', px: 8 },
  },
}
