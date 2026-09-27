import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { WorkerDeckError } from '@workerdeck/client'

export type UseAsyncOptions = {
  enabled?: boolean
  pollMs?: number
}

export type UseAsyncResult<T> = {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => Promise<void>
  setData: Dispatch<SetStateAction<T | undefined>>
}

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

// A change of `deps` drops the previous answer; `enabled` flipping on, a poll and `reload` keep it until the next one lands.
export function useAsync<T>(
  load: () => Promise<T>,
  deps: DependencyList,
  { enabled = true, pollMs }: UseAsyncOptions = {},
): UseAsyncResult<T> {
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(enabled)
  const generation = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const run = useCallback(async () => {
    const id = ++generation.current
    setLoading(true)
    try {
      const next = await loadRef.current()
      if (id === generation.current) {
        setData(() => next)
        setError(undefined)
      }
    } catch (e) {
      if (id === generation.current) {
        setError(e)
      }
    } finally {
      if (id === generation.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    setData(undefined)
    setError(undefined)
  }, deps)

  useEffect(() => {
    if (!enabled) {
      generation.current++
      setLoading(false)
      return
    }
    void run()
    const timer = pollMs ? setInterval(() => void run(), pollMs) : undefined
    return () => {
      generation.current++
      clearInterval(timer)
    }
  }, [enabled, pollMs, run, ...deps])

  return { data, error, loading, reload: run, setData }
}
