import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { WorkerDeckError, type WorkerDeckClient } from '@workerdeck/client'
import { currentText, initialOpenFilesState, isDirty, openFilesReducer, type OpenFile, type OpenFilesState } from '../lib/open-files.ts'

export type UseOpenFilesResult = OpenFilesState & {
  /** The focused file, resolved — what the editor renders. */
  active: OpenFile | undefined
  /** Any tab with unsaved edits — what a close or unload guard asks. */
  hasUnsaved: boolean
  /** Open a path, or focus it if it is already open. */
  open: (path: string) => void
  close: (path: string) => void
  closeAll: () => void
  activate: (path: string) => void
  /** Record a keystroke. Pure state; nothing is written until `save`. */
  edit: (path: string, content: string) => void
  /** Write the tab's edits, conditional on the hash it read. No-op if clean. */
  save: (path: string) => Promise<void>
  /** Throw the tab's edits away and go back to what was read. */
  revert: (path: string) => void
  /** Re-read from disk. **Discards unsaved edits** — only call on an explicit
   * choice, never to "refresh". */
  reload: (path: string) => void
  /** Resolve a conflict by taking this tab's version: re-read for the current
   * hash, then write the draft against it. */
  overwrite: (path: string) => Promise<void>
  /** Dismiss the conflict banner without resolving it. */
  dismissConflict: (path: string) => void
}

/**
 * The open-file tabs of a workspace: which files are open, which is focused, the bytes behind
 * each, and the edits on top of them. A tab is an absolute host path and this hook is
 * deliberately not given the session's cwd — containment is the server's job on every `/fs/read`
 * and `/fs/write` (`docs/GOTCHAS.md` §Host filesystem), never re-derived here.
 */
export const useOpenFiles = (client: WorkerDeckClient): UseOpenFilesResult => {
  const [state, dispatch] = useReducer(openFilesReducer, initialOpenFilesState)

  // Paths whose read has been started. Not derived from status, because a tab
  // stays 'loading' for the whole round trip and the effect re-runs on every
  // unrelated tab change in the meantime.
  const requested = useRef(new Set<string>())
  // Reads and writes outlive the component on a fast close-and-unmount; the flag
  // is what stops a resolved promise dispatching into a dead reducer.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The latest state, for callbacks that must read a tab at call time rather
  // than close over the render they were created in — `save` is invoked from a
  // keybinding that outlives any single render.
  const latest = useRef(state)
  useEffect(() => {
    latest.current = state
  }, [state])

  const loading = state.files.filter((f) => f.status === 'loading')
  // Join the paths so the effect's identity tracks the *set* of pending reads,
  // not the array that the reducer rebuilds on every action.
  const pending = loading.map((f) => f.path).join('\n')

  const read = useCallback(
    (path: string) =>
      client.readHostFile(path).then((response) => {
        if (!alive.current) {
          return undefined
        }
        dispatch({
          type: 'loaded',
          // The gateway answers with the canonical path; the tab is keyed on
          // what was asked for, so dispatch under that and let the response's
          // own path stay an implementation detail of the read.
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
    // Forget the request too, so reopening the tab reads again rather than
    // sitting on 'loading' forever.
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

  /** One conditional write. Shared by `save` and `overwrite`, which differ only
   * in where the hash came from. */
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
        // 409 is the whole point of the conditional write: the file moved under
        // this tab. It is a choice to offer, not a message to print.
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
      // The text to keep, captured before the re-read — `loaded` would clear the
      // draft, which is exactly what "take mine" must not do.
      const mine = currentText(file)
      dispatch({ type: 'saveStart', path })
      try {
        // There is no unconditional overwrite by design, so taking this tab's
        // version means learning the *current* hash and writing against it. The
        // window between this read and the write is small but real; a second 409
        // is the correct answer if the agent writes inside it.
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
