import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'
import type { HostFileMatch } from '@workerdeck/protocol'
import { ancestorsWithin, flattenHostTree, type HostDirState, type HostTreeRow } from '../lib/host-tree.ts'

export type UseHostFileSearchResult = {
  /**
   * Whether `@file` completion is on offer at all: the session's cwd is known
   * and this gateway hasn't already 404'd the search. Read it before advertising
   * the affordance — a server without host files configured has none.
   */
  available: boolean
  /**
   * Run one search. Safe to call per keystroke — the route is built for it
   * (bounded walk, build directories skipped) — and it answers `[]` rather than
   * throwing, because a failed lookup is not worth an error banner over an
   * affordance the user can ignore.
   */
  search: (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<HostFileMatch[]>
}

/**
 * Fuzzy file search rooted at a session's working directory — what an `@file` picker needs. Never
 * offers the roots list: `hostFiles.roots` is the server's security boundary, not a place to
 * navigate. Self-disabling on a 404, which is answered once for the whole session.
 */
export const useHostFileSearch = (client: WorkerDeckClient, cwd: string | undefined): UseHostFileSearchResult => {
  const [unsupported, setUnsupported] = useState(false)
  // A resume into a different directory invalidates the verdict as well as the
  // results — the new cwd may well be under a configured root.
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
        // No host files on this gateway (or the cwd isn't under a root).
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
  /** Whether this gateway serves host files at all. */
  available: boolean
  /**
   * Whether `PUT /fs/write` is enabled here.
   *
   * Read it before offering an editor. Writing is a **separate** server opt-in
   * from reading and defaults off, so a gateway that happily lists and reads a
   * tree may still refuse every save — and finding that out at save time, with
   * edits already made, is the worst moment for it.
   */
  canWrite: boolean
}

/**
 * Whether host files are served here, and whether they may be written.
 *
 * One request per client, cached for the life of the hook: the roots and the
 * write flag are gateway configuration, not session state, and they do not
 * change while the tab is open.
 */
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
      // A 404 means no host files here; anything else means we could not find
      // out. Both answer the same way, because the safe default for "may I
      // write to the operator's disk?" is no.
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
  /**
   * Whether a tree can be shown at all: the cwd is known and this gateway serves
   * host files. Read it before rendering the rail — a gateway with no
   * `hostFiles` configured has no tree, and that is a layout decision, not an
   * error to display.
   */
  available: boolean
  /** The directory the tree is rooted at — the session's cwd. */
  root: string | undefined
  /** The visible tree, flattened. Empty until the root listing arrives. */
  rows: HostTreeRow[]
  /** True while the root listing is outstanding and there is nothing to show. */
  loading: boolean
  /** A listing that failed, verbatim from the gateway. */
  error: string | undefined
  /** Expand or collapse a directory. Expanding lists it once and remembers. */
  toggle: (path: string) => void
  /** Expand every directory between the root and this path, so it is on screen. */
  reveal: (path: string) => void
  /** Re-list one directory (default: the root), keeping what is expanded. */
  refresh: (path?: string) => void
}

/**
 * An expandable file tree rooted at a session's working directory, for the same reason
 * {@link useHostFileSearch} is. Listings are cached per directory and kept across a collapse, so
 * a reopened folder is instant and deliberately stale until `refresh`. Self-disabling on a 404.
 */
export const useHostFileTree = (client: WorkerDeckClient, cwd: string | undefined): UseHostFileTreeResult => {
  const [dirs, setDirs] = useState<Map<string, HostDirState>>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | undefined>()

  // A resume into a different project invalidates everything, including the
  // 404 verdict — the new cwd may well be under a configured root.
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

  // Directories whose listing has been asked for. A ref rather than state: it
  // must not re-render anything, and it is what keeps an expand-collapse-expand
  // from issuing three requests.
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
            // Keyed on the requested path, not the canonical one the server
            // answers with: the tree navigates by the paths `/fs/list` gave it,
            // and re-keying on a resolved path would orphan the node that asked.
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
            // No host files on this gateway, or the cwd is not under a root.
            // Not an error banner — the rail simply is not on offer.
            setUnsupported(true)
            return
          }
          setError(e instanceof Error ? e.message : 'Could not read that directory')
        })
    },
    [client, unsupported],
  )

  // The root lists itself; everything below is listed on expand.
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
      // Outside the updater on purpose — React may run an updater twice, and a
      // request fired from inside one is a side effect in a place that promises
      // not to have any. Listing is idempotent (`requested` guards it) and the
      // first action on a directory is always an expand, so the call this makes
      // on a *collapse* has already been answered and does nothing.
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
