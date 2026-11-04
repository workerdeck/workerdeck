import { errorMessage, type HostSearchEvent, type HostSearchRequest } from '@workerdeck/protocol'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  EMPTY_HOST_SEARCH_QUERY,
  hostSearchCounts,
  hostSearchReducer,
  hostSearchRequest,
  initialHostSearchState,
  type HostSearchQuery,
  type HostSearchState,
} from '../lib/host-search.ts'

export type HostSearchRun = (request: HostSearchRequest, signal: AbortSignal) => AsyncIterable<HostSearchEvent>

export type UseHostSearchOptions = {
  root: string | undefined
  run: HostSearchRun
  settingsExcludes?: readonly string[]
  searchOnType?: boolean
  debounceMs?: number
  maxResults?: number
  initialQuery?: Partial<HostSearchQuery>
}

export type UseHostSearchResult = {
  query: HostSearchQuery
  setQuery: (patch: Partial<HostSearchQuery>) => void
  state: HostSearchState
  counts: { files: number; matches: number }
  search: () => void
  cancel: () => void
  clear: () => void
  dismissFile: (path: string) => void
  dismissMatch: (path: string, key: string) => void
  dismissMatches: (files: { path: string; keys: string[] }[]) => void
}

const SEARCH_KEYS = ['query', 'isRegex', 'matchCase', 'wholeWord', 'includes', 'excludes', 'useIgnoreFiles'] as const

export function useHostSearch(options: UseHostSearchOptions): UseHostSearchResult {
  const { root, searchOnType = true, debounceMs = 300, maxResults } = options
  const [query, setQueryState] = useState<HostSearchQuery>(() => ({ ...EMPTY_HOST_SEARCH_QUERY, ...options.initialQuery }))
  const [state, dispatch] = useReducer(hostSearchReducer, initialHostSearchState)
  const runRef = useRef(options.run)
  runRef.current = options.run
  const excludesRef = useRef(options.settingsExcludes)
  excludesRef.current = options.settingsExcludes
  const queryRef = useRef(query)
  queryRef.current = query
  const active = useRef<AbortController | undefined>(undefined)
  const sequence = useRef(0)

  const cancel = useCallback(() => {
    active.current?.abort()
    active.current = undefined
  }, [])

  const search = useCallback(() => {
    cancel()
    const current = queryRef.current
    if (!root || current.query === '') {
      dispatch({ type: 'clear' })
      return
    }
    const run = ++sequence.current
    const controller = new AbortController()
    active.current = controller
    dispatch({ type: 'start', run })
    const request = hostSearchRequest(root, current, excludesRef.current ?? [], maxResults)
    void (async () => {
      try {
        for await (const event of runRef.current(request, controller.signal)) {
          if (controller.signal.aborted) {
            return
          }
          dispatch({ type: 'event', run, event })
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          dispatch({ type: 'fail', run, message: errorMessage(e) })
        }
      } finally {
        if (active.current === controller) {
          active.current = undefined
        }
      }
    })()
  }, [cancel, maxResults, root])

  const searchKey = SEARCH_KEYS.map((key) => String(query[key])).join('\u0000')
  const excludesKey = (options.settingsExcludes ?? []).join('\u0000')
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      if (queryRef.current.query === '') {
        return
      }
    }
    if (!searchOnType) {
      return
    }
    const timer = setTimeout(search, queryRef.current.query === '' ? 0 : debounceMs)
    return () => clearTimeout(timer)
  }, [searchKey, excludesKey, search, searchOnType, debounceMs])

  useEffect(() => cancel, [cancel])

  const setQuery = useCallback((patch: Partial<HostSearchQuery>) => {
    setQueryState((previous) => ({ ...previous, ...patch }))
  }, [])

  const clear = useCallback(() => {
    cancel()
    setQueryState((previous) => ({ ...previous, query: '', replace: '' }))
    dispatch({ type: 'clear' })
  }, [cancel])

  const dismissFile = useCallback((path: string) => dispatch({ type: 'dismiss-file', path }), [])
  const dismissMatch = useCallback((path: string, key: string) => dispatch({ type: 'dismiss-match', path, key }), [])
  const dismissMatches = useCallback((files: { path: string; keys: string[] }[]) => dispatch({ type: 'dismiss-matches', files }), [])
  const counts = useMemo(() => hostSearchCounts(state), [state])

  return { query, setQuery, state, counts, search, cancel, clear, dismissFile, dismissMatch, dismissMatches }
}
