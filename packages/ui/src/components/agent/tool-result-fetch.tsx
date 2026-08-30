import { createContext, useContext, type ReactNode } from 'react'

/**
 * How a row gets back the part of a tool result the replay did not send.
 *
 * The default is a no-op resolving `false`, correct for every surface that
 * never asked for truncation: `result.truncated` is only ever set by a replay a
 * renderer opted into, so a row with no fetcher also has no head to complete.
 */
export type ToolResultFetcher = (toolUseId: string) => Promise<boolean>

const noop: ToolResultFetcher = async () => false
const FetchContext = createContext<ToolResultFetcher>(noop)

export function ToolResultFetchProvider({ value, children }: { value: ToolResultFetcher | undefined; children: ReactNode }) {
  return <FetchContext.Provider value={value ?? noop}>{children}</FetchContext.Provider>
}

export function useToolResultFetcher(): ToolResultFetcher {
  return useContext(FetchContext)
}
