import { useCallback, useState } from 'react'

export type CatchUpMark = { itemCount: number; since?: number }

type CatchUpState = { sessionId: string | undefined; mark: CatchUpMark | undefined; caughtUp: boolean }

// The mark is the host's `unseen` as it stood when this session opened; later values are the host catching up, not news.
export function useCatchUp(
  sessionId: string | undefined,
  unseen: CatchUpMark | undefined,
): { mark: CatchUpMark | undefined; dismiss: () => void } {
  const [held, setHeld] = useState<CatchUpState>({ sessionId, mark: unseen, caughtUp: false })
  let current = held
  if (held.sessionId !== sessionId) {
    current = { sessionId, mark: unseen, caughtUp: false }
    setHeld(current)
  }
  const dismiss = useCallback(() => setHeld((prev) => (prev.caughtUp ? prev : { ...prev, caughtUp: true })), [])
  return { mark: current.caughtUp ? undefined : current.mark, dismiss }
}
