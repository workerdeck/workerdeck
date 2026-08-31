import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'
import type { HostFileMatch } from '@workerdeck/protocol'
import { ancestorsWithin, flattenHostTree, type HostDirState, type HostTreeRow } from '../lib/host-tree.ts'

export type UseHostFileSearchResult = {
  available: boolean
  search: (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<HostFileMatch[]>
}

export const useHostFileSearch = (client: WorkerDeckClient, cwd: string | undefined): UseHostFileSearchResult => {
  const [unsupported, setUnsupported] = useState(false)
  const lastCwd = useRef(cwd)
  useEffect(() => {
    if (lastCwd.current !== cwd) {
      lastCwd.current = cwd
      setUnsupported(false)
    }
  }, [cwd])

  const search = useCallback(
    async (query: string, options?: { limit?: number; signal?: AbortSignal }) => {
      if (!cwd || unsupported) {
        return []
      }
      try {
        const response = await client.findHostFiles(cwd, query, options?.limit ?? 8)
        return options?.signal?.aborted ? [] : response.matches
      } catch (e) {
        if (isRouteUnsupported(e)) {
          setUnsupported(true)
        }
        return []
      }
    },
    [client, cwd, unsupported],
  )

  return { available: !!cwd && !unsupported, search }
}

export type UseHostFileRootsResult = {
  available: boolean
  canWrite: boolean
}

export const useHostFileRoots = (client: WorkerDeckClient): UseHostFileRootsResult => {
  const [result, setResult] = useState<UseHostFileRootsResult>({
    available: false,
    canWrite: false,
  })
  useEffect(() => {
    let cancelled = false
    client
      .listHostRoots()
      .then((response) => {
        if (!cancelled) {
          setResult({ available: true, canWrite: response.canWrite })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ available: false, canWrite: false })
        }
      })
    return () => {
      cancelled = true
    }
  }, [client])
  return result
}

export type UseHostFileTreeResult = {
  available: boolean
  root: string | undefined
  rows: HostTreeRow[]
  loading: boolean
  error: string | undefined
  toggle: (path: string) => void
  reveal: (path: string) => void
  refresh: (path?: string) => void
}

export const useHostFileTree = (client: WorkerDeckClient, cwd: string | undefined): UseHostFileTreeResult => {
  const [dirs, setDirs] = useState<Map<string, HostDirState>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const lastCwd = useRef(cwd)
  useEffect(() => {
    if (lastCwd.current === cwd) {
      return
    }
    lastCwd.current = cwd
    setDirs(new Map())
    setExpanded(new Set())
    setUnsupported(false)
    setError(undefined)
  }, [cwd])

  const alive = useAliveRef()

  const requested = useRef(new Set<string>())

  const list = useCallback(
    (target: string, { force = false } = {}) => {
      if (unsupported) {
        return
      }
      if (!force && requested.current.has(target)) {
        return
      }
      requested.current.add(target)
      client
        .listHostDir(target)
        .then((response) => {
          if (!alive.current) {
            return
          }
          setDirs((previous) => {
            const next = new Map(previous)
            // Keyed on the path asked for, never the canonical one answered: re-keying orphans the node that asked.
            next.set(target, { entries: response.entries, truncated: response.truncated })
            return next
          })
        })
        .catch((e: unknown) => {
          if (!alive.current) {
            return
          }
          requested.current.delete(target)
          if (isRouteUnsupported(e)) {
            setUnsupported(true)
            return
          }
          setError(e instanceof Error ? e.message : 'Could not read that directory')
        })
    },
    [client, unsupported],
  )

  useEffect(() => {
    if (cwd) {
      list(cwd)
    }
  }, [cwd, list])

  const toggle = useCallback(
    (path: string) => {
      setExpanded((previous) => {
        const next = new Set(previous)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
      // Outside the updater, which React may run twice; `requested` makes this a no-op on the collapse.
      list(path)
    },
    [list],
  )

  const reveal = useCallback(
    (path: string) => {
      if (!cwd) {
        return
      }
      const ancestors = ancestorsWithin(cwd, path)
      if (ancestors.length === 0) {
        return
      }
      for (const dir of ancestors) {
        list(dir)
      }
      setExpanded((previous) => {
        const next = new Set(previous)
        for (const dir of ancestors) {
          next.add(dir)
        }
        return next
      })
    },
    [cwd, list],
  )

  const refresh = useCallback(
    (path?: string) => {
      const target = path ?? cwd
      if (!target) {
        return
      }
      setError(undefined)
      list(target, { force: true })
    },
    [cwd, list],
  )

  const rows = useMemo(() => (cwd ? flattenHostTree(cwd, dirs, expanded) : []), [cwd, dirs, expanded])

  return {
    available: !!cwd && !unsupported,
    root: cwd,
    rows,
    loading: !!cwd && !unsupported && !dirs.has(cwd) && !error,
    error,
    toggle,
    reveal,
    refresh,
  }
}
