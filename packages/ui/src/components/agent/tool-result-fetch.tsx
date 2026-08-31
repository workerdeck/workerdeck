import { createContext, useContext, type ReactNode } from 'react'

export type ToolResultFetcher = (toolUseId: string) => Promise<boolean>

const noop: ToolResultFetcher = async () => false
const FetchContext = createContext<ToolResultFetcher>(noop)

export function ToolResultFetchProvider({ value, children }: { value: ToolResultFetcher | undefined; children: ReactNode }) {
  return <FetchContext.Provider value={value ?? noop}>{children}</FetchContext.Provider>
}

export const useToolResultFetcher = (): ToolResultFetcher => {
  return useContext(FetchContext)
}
