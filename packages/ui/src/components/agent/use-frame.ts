import { useCallback, useEffect, useRef, useState } from 'react'

export type FrameReveal = { toolUseId: string; nonce: number }

export type FrameOptions = {
  sessionId: string | undefined
  // A host request to enter a frame; `id: undefined` withdraws it.
  request?: { id: string | undefined; nonce: number }
  // A host request to reveal a transcript row: it closes the frame without the return reveal, which would fight it.
  reveal?: { nonce: number }
  onChange?: (id: string | undefined) => void
  // The transcript row leaving the frame reveals, so the reader lands where they left.
  returnTo: (id: string) => string | undefined
}

export type Frame = {
  id: string | undefined
  enter: (id: string) => void
  leave: () => void
  returnReveal: FrameReveal | undefined
}

// The frame machine behind both the sub-agent and the shell takeover. The frame round-trips through
// the host's URL (GOTCHAS "The sub-agent frame round-trips through the URL"): entry keys on the nonce
// alone, and the report is deduped through a ref, so an echo of our own report is inert on arrival.
export function useFrame({ sessionId, request, reveal, onChange, returnTo }: FrameOptions): Frame {
  const [id, setId] = useState<string | undefined>(undefined)
  const [returnReveal, setReturnReveal] = useState<FrameReveal | undefined>(undefined)
  useEffect(() => {
    setId(undefined)
    setReturnReveal(undefined)
  }, [sessionId])

  const returnToRef = useRef(returnTo)
  returnToRef.current = returnTo
  const leave = useCallback(() => {
    setId((current) => {
      const toolUseId = current === undefined ? undefined : returnToRef.current(current)
      if (toolUseId !== undefined) {
        setReturnReveal({ toolUseId, nonce: Date.now() })
      }
      return undefined
    })
  }, [])

  const requestNonce = request?.nonce
  const requestId = request?.id
  useEffect(() => {
    if (requestId === undefined) {
      leave()
    } else {
      setId(requestId)
    }
  }, [requestNonce])

  const revealNonce = reveal?.nonce
  useEffect(() => {
    if (revealNonce !== undefined) {
      setId(undefined)
    }
  }, [revealNonce])

  useEffect(() => {
    if (id === undefined) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        leave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, leave])

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const reported = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (reported.current === id) {
      return
    }
    reported.current = id
    onChangeRef.current?.(id)
  }, [id])

  return { id, enter: setId, leave, returnReveal }
}
