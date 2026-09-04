import { createContext, useContext, type ReactNode } from 'react'
import { toolTitle } from '@workerdeck/protocol'

const TitlesContext = createContext<Record<string, string> | undefined>(undefined)

export function ToolTitleProvider({ value, children }: { value: Record<string, string> | undefined; children: ReactNode }) {
  return <TitlesContext.Provider value={value}>{children}</TitlesContext.Provider>
}

export function useToolTitle(name: string): string | undefined {
  return toolTitle(name, useContext(TitlesContext))
}
