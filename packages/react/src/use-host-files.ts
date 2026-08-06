import { useCallback, useEffect, useRef, useState } from 'react'
import { WorkerDeckError, type WorkerDeckClient } from '@workerdeck/client'
import type { HostFileMatch } from '@workerdeck/protocol'

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
 * Fuzzy file search rooted at a session's working directory — what an `@file`
 * picker needs.
 *
 * Deliberately session-scoped: the server's `hostFiles.roots` are the security
 * boundary, but what someone wants while talking to an agent is *this* project's
 * tree, so this never offers the roots list.
 *
 * A gateway that answers 404 once has answered for the session: host files are
 * either configured or they aren't, and the answer will not change while the cwd
 * holds. Asking again on every character would be a request per keystroke for a
 * feature that does not exist here.
 */
export function useHostFileSearch(
  client: WorkerDeckClient,
  cwd: string | undefined,
): UseHostFileSearchResult {
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
      if (!cwd || unsupported) return []
      try {
        const response = await client.findHostFiles(cwd, query, options?.limit ?? 8)
        return options?.signal?.aborted ? [] : response.matches
      } catch (e) {
        // No host files on this gateway (or the cwd isn't under a root).
        if (e instanceof WorkerDeckError && e.status === 404) setUnsupported(true)
        return []
      }
    },
    [client, cwd, unsupported],
  )

  return { available: !!cwd && !unsupported, search }
}
