import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { WorkerDeckError, type WorkerDeckClient } from '@workerdeck/client'
import { currentText, initialOpenFilesState, isDirty, openFilesReducer, type OpenFile, type OpenFilesState } from '../lib/open-files.ts'

export type UseOpenFilesResult = OpenFilesState & {
  active: OpenFile | undefined
  hasUnsaved: boolean
  open: (path: string) => void
  close: (path: string) => void
  closeAll: () => void
  activate: (path: string) => void
  edit: (path: string, content: string) => void
  save: (path: string) => Promise<void>
  revert: (path: string) => void
  reload: (path: string) => void
  overwrite: (path: string) => Promise<void>
  dismissConflict: (path: string) => void
}

export function useOpenFiles(client: WorkerDeckClient): UseOpenFilesResult {
  const [state, dispatch] = useReducer(openFilesReducer, initialOpenFilesState)

  const requested = useRef(new Set<string>())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const latest = useRef(state)
  useEffect(() => {
    latest.current = state
  }, [state])

  const loading = state.files.filter((f) => f.status === 'loading')
  // Joined so the effect's identity is the set of pending reads, not the array the reducer rebuilds.
  const pending = loading.map((f) => f.path).join('\n')

  const read = useCallback(
    (path: string) =>
      client.readHostFile(path).then((response) => {
        if (!alive.current) {
          return undefined
        }
        dispatch({
          type: 'loaded',
          // The tab is keyed on the path asked for, never the canonical one the gateway answers with.
          path,
          content: response.content,
          encoding: response.encoding,
          bytes: response.bytes,
          hash: response.hash,
          modifiedAt: response.modifiedAt,
        })
        return response
      }),
    [client],
  )

  useEffect(() => {
    for (const path of pending ? pending.split('\n') : []) {
      if (requested.current.has(path)) {
        continue
      }
      requested.current.add(path)
      read(path).catch((e: unknown) => {
        if (!alive.current) {
          return
        }
        dispatch({
          type: 'failed',
          path,
          error: e instanceof Error ? e.message : 'Could not read that file',
        })
      })
    }
  }, [read, pending])

  const open = useCallback((path: string) => dispatch({ type: 'open', path }), [])
  const close = useCallback((path: string) => {
    requested.current.delete(path)
    dispatch({ type: 'close', path })
  }, [])
  const closeAll = useCallback(() => {
    requested.current.clear()
    dispatch({ type: 'closeAll' })
  }, [])
  const activate = useCallback((path: string) => dispatch({ type: 'activate', path }), [])
  const edit = useCallback((path: string, content: string) => dispatch({ type: 'edit', path, content }), [])
  const revert = useCallback((path: string) => dispatch({ type: 'revert', path }), [])
  const dismissConflict = useCallback((path: string) => dispatch({ type: 'dismissConflict', path }), [])

  const reload = useCallback(
    (path: string) => {
      requested.current.add(path)
      read(path).catch((e: unknown) => {
        if (!alive.current) {
          return
        }
        dispatch({
          type: 'failed',
          path,
          error: e instanceof Error ? e.message : 'Could not re-read that file',
        })
      })
    },
    [read],
  )

  const write = useCallback(
    async (path: string, text: string, expectedHash: string | undefined) => {
      try {
        const response = await client.writeHostFile({ path, content: text, expectedHash })
        if (!alive.current) {
          return
        }
        dispatch({
          type: 'saved',
          path,
          content: text,
          bytes: response.bytes,
          hash: response.hash,
          modifiedAt: response.modifiedAt,
        })
      } catch (e) {
        if (!alive.current) {
          return
        }
        const conflict = e instanceof WorkerDeckError && e.status === 409
        dispatch({
          type: 'saveFailed',
          path,
          conflict,
          error: conflict ? 'This file changed on disk since you opened it.' : e instanceof Error ? e.message : 'Could not save that file',
        })
      }
    },
    [client],
  )

  const save = useCallback(
    async (path: string) => {
      const file = latest.current.files.find((f) => f.path === path)
      if (!file || file.saving || !isDirty(file)) {
        return
      }
      dispatch({ type: 'saveStart', path })
      await write(path, currentText(file), file.hash)
    },
    [write],
  )

  const overwrite = useCallback(
    async (path: string) => {
      const file = latest.current.files.find((f) => f.path === path)
      if (!file || file.saving) {
        return
      }
      // Captured before the re-read, whose `loaded` clears the draft — the one thing "take mine" must not do.
      const mine = currentText(file)
      dispatch({ type: 'saveStart', path })
      try {
        const fresh = await client.readHostFile(path)
        if (!alive.current) {
          return
        }
        await write(path, mine, fresh.hash)
      } catch (e) {
        if (!alive.current) {
          return
        }
        dispatch({
          type: 'saveFailed',
          path,
          error: e instanceof Error ? e.message : 'Could not save that file',
        })
      }
    },
    [client, write],
  )

  const active = useMemo(() => state.files.find((f) => f.path === state.activePath), [state.files, state.activePath])
  const hasUnsaved = useMemo(() => state.files.some(isDirty), [state.files])

  return {
    ...state,
    active,
    hasUnsaved,
    open,
    close,
    closeAll,
    activate,
    edit,
    save,
    revert,
    reload,
    overwrite,
    dismissConflict,
  }
}
