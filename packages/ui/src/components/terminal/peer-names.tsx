import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { peerNamesOf } from './tool-run.ts'

const EMPTY: ReadonlyMap<string, string> = new Map()

const PeerNamesContext = createContext<ReadonlyMap<string, string>>(EMPTY)

export function PeerNamesProvider({ items, children }: { items: readonly TranscriptItem[]; children: ReactNode }) {
  const last = useRef(EMPTY)
  const names = useMemo(() => {
    const next = peerNamesOf(items)
    const same = next.size === last.current.size && [...next].every(([id, name]) => last.current.get(id) === name)
    if (!same) {
      last.current = next
    }
    return last.current
  }, [items])
  return <PeerNamesContext.Provider value={names}>{children}</PeerNamesContext.Provider>
}

export function usePeerNames(): ReadonlyMap<string, string> {
  return useContext(PeerNamesContext)
}
