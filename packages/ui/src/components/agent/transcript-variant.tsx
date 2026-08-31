import { createContext, useContext, type ReactNode } from 'react'

export type TranscriptVariant = 'cards' | 'terminal'

const VariantContext = createContext<TranscriptVariant>('cards')

export function TranscriptVariantProvider({ value, children }: { value: TranscriptVariant; children: ReactNode }) {
  return <VariantContext.Provider value={value}>{children}</VariantContext.Provider>
}

export function useTranscriptVariant(): TranscriptVariant {
  return useContext(VariantContext)
}

export type TranscriptDensity = 'comfortable' | 'compact'

const DensityContext = createContext<TranscriptDensity>('comfortable')

export function TranscriptDensityProvider({ value, children }: { value: TranscriptDensity; children: ReactNode }) {
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
}

export function useTranscriptDensity(): TranscriptDensity {
  return useContext(DensityContext)
}

export type TranscriptFont = 'sans' | 'mono'

export const ROW_GAP: Record<TranscriptVariant, Record<TranscriptDensity, { className?: string; px: number }>> = {
  terminal: {
    comfortable: { className: 'term-row-gap', px: 18 },
    compact: { className: 'term-row-gap', px: 18 },
  },
  cards: {
    comfortable: { className: 'pt-4', px: 16 },
    compact: { className: 'pt-2', px: 8 },
  },
}
