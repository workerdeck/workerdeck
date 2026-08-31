import { useEffect, useRef, type RefObject } from 'react'
import { WorkerDeckError } from '@workerdeck/client'

// Set in an effect, not at declaration: StrictMode remounts, and a once-initialised ref stays false.
export function useAliveRef(): RefObject<boolean> {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return alive
}

export function isRouteUnsupported(e: unknown): boolean {
  return e instanceof WorkerDeckError && e.status === 404
}
