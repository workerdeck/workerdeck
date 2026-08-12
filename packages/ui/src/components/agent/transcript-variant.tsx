import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

/**
 * How the transcript draws a turn.
 *
 * - `cards` — the chat convention: bubbles, bordered tool cards, generous gaps.
 *   Right for a wide dashboard where the transcript is the page.
 * - `lines` — one full-width line item per event, transparent, hover-highlit,
 *   with a glyph in a fixed left gutter. Right where vertical space is the
 *   scarce resource (a VS Code dock) and the terminal is the reference UX:
 *   nothing is boxed, the content and its marker carry the comprehension.
 *
 * A context rather than a prop chain because every row component needs it and
 * only the transcript root knows it — and because `Message`/`ToolCallCard` are
 * exported on their own, so an embedder composing them by hand gets the right
 * treatment for free.
 */
export type TranscriptVariant = 'cards' | 'lines'

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

/** True in `lines`, for the many `cond ? a : b` reads in the row components. */
export function useLines(): boolean {
  return useTranscriptVariant() === 'lines'
}

/**
 * How much room the transcript gives each row.
 *
 * - `comfortable` — a blank line between messages, which is what the Claude Code
 *   CLI does and what the `lines` variant is trying to read like. The default:
 *   a transcript is prose before it is a table.
 * - `compact` — rows tight against each other, for a dock where every line of
 *   vertical space is contested.
 *
 * Separate from the variant, and deliberately: they answer different questions.
 * The variant decides *how a row is drawn* (boxed or not) and follows from the
 * surface; density decides *how much air is around it* and is a preference the
 * reader holds. Coupling them would mean a dock could not be roomy and a
 * dashboard could not be dense.
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
 *
 * `lines` + `compact` is the only combination with no gap at all: there the
 * row's own `py-0.5` is the entire separation, which is what makes it compact.
 */
export const ROW_GAP: Record<
  TranscriptVariant,
  Record<TranscriptDensity, { className?: string; px: number }>
> = {
  cards: {
    comfortable: { className: 'pt-4', px: 16 },
    compact: { className: 'pt-2', px: 8 },
  },
  lines: {
    // 16px on top of the row's own 4px of `py-0.5` is one 20px line — the blank
    // line the CLI leaves, arrived at from the line height rather than picked.
    comfortable: { className: 'pt-4', px: 16 },
    compact: { px: 0 },
  },
}

/**
 * The left gutter of a line item: one glyph, fixed width, so every row's text
 * starts on the same column no matter which kind of event it is. Decorative —
 * the row's own text says what it is.
 */
export function LineGlyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'w-3.5 shrink-0 select-none text-center font-mono text-label leading-5 text-fg-4',
        className,
      )}>
      {children}
    </span>
  )
}

/** Body text metrics for a line item — tighter than the card variant's. */
export const LINE_TEXT = 'text-body-sm leading-5'
