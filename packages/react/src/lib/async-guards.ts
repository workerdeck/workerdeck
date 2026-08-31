import { useEffect, useRef, type RefObject } from 'react'
import { WorkerDeckError } from '@workerdeck/client'

/**
 * A ref that reads true only while the component is mounted.
 *
 * Set in an effect rather than at declaration, because StrictMode mounts,
 * unmounts and remounts: a ref initialised once would stay false after the
 * second mount and the hook would silently never store another answer.
 */
export const useAliveRef = (): RefObject<boolean> => {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return alive
}

/**
 * The self-disabling verdict: a gateway that answers 404 for a route has
 * answered for the whole session — it will not grow the route mid-run — so the
 * caller stops asking instead of logging a miss every poll. Any other failure is
 * a blip and must keep the last reading rather than replace a dated number with
 * nothing at all.
 */
export const isRouteUnsupported = (e: unknown): boolean => e instanceof WorkerDeckError && e.status === 404
