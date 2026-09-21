import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { peerNamesOf } from './tool-run.ts'

const EMPTY: ReadonlyMap<string, string> = new Map()

const PeerNamesContext = createContext<ReadonlyMap<string, string>>(EMPTY)

export function PeerNamesProvider({ items, children }: { items: readonly TranscriptItem[]; children: ReactNode }) {
  const names = useMemo(() => peerNamesOf(items), [items])
  return <PeerNamesContext.Provider value={names}>{children}</PeerNamesContext.Provider>
}

export function usePeerNames(): ReadonlyMap<string, string> {
  return useContext(PeerNamesContext)
}
