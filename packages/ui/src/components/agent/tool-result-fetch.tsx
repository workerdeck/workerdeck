import { createContext, useContext, type ReactNode } from 'react'

/**
 * How a row gets back the part of a tool result the replay did not send.
 *
 * A **context**, not a prop chain, for the same reason the variant is one: the
 * rows that need it are drawn by `terminalBlocks` and by the cards theme's
 * `ToolCallCard`, several layers below whoever holds the session, and a row
 * composed by hand should get the same behaviour without threading a callback
 * through everything in between.
 *
 * The default is a no-op resolving `false`, which is exactly right for every
 * surface that never asked for truncation (the playground, a fixture, an
 * embedder rendering rows by hand): `result.truncated` is only ever set by a
 * replay a renderer opted into, so a row that has no fetcher also has no head to
 * complete. A press still opens the row; it simply has everything already.
 */
export type ToolResultFetcher = (toolUseId: string) => Promise<boolean>

const FetchContext = createContext<ToolResultFetcher>(async () => false)

export function ToolResultFetchProvider({
  value,
  children,
}: {
  value: ToolResultFetcher | undefined
  children: ReactNode
}) {
  return <FetchContext.Provider value={value ?? noop}>{children}</FetchContext.Provider>
}

const noop: ToolResultFetcher = async () => false

export function useToolResultFetcher(): ToolResultFetcher {
  return useContext(FetchContext)
}
