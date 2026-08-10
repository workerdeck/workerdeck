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
