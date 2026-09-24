import { createContext, useContext, type ReactNode } from 'react'

export type TranscriptVariant = 'cards' | 'terminal'

const VariantContext = createContext<TranscriptVariant>('cards')

export function TranscriptVariantProvider({ value, children }: { value: TranscriptVariant; children: ReactNode }) {
  return <VariantContext.Provider value={value}>{children}</VariantContext.Provider>
}

export function useTranscriptVariant(): TranscriptVariant {
  return useContext(VariantContext)
}

export type TranscriptFont = 'sans' | 'mono'

export const ROW_GAP: Record<TranscriptVariant, { className?: string; px: number }> = {
  terminal: { className: 'term-row-gap', px: 18 },
  cards: { className: 'pt-5', px: 20 },
}
