/**
 * One open file, in whatever state its read got to.
 *
 * A tab exists from the moment it is opened, before any bytes arrive — the tab
 * strip is the record of what the user asked for, not of what the gateway has
 * answered, and a tab that only appeared once the read landed would make a slow
 * read look like a dead click.
 */
export type OpenFile = {
  /** Absolute host path — the tab's identity. Opening the same path twice
   * focuses the existing tab rather than making a second one. */
  path: string
  /** Last segment, for the tab label. */
  name: string
  status: 'loading' | 'ready' | 'binary' | 'error'
  /** The text **as last seen on disk** — never the user's edits. */
  content?: string
  /**
   * The user's unsaved text. Absent when nothing has been typed since the last
   * read or save.
   *
   * Kept separate from `content` rather than overwriting it, because a
   * conditional write needs to know both: what is being sent, and what the
   * `hash` describes. Collapsing them would make "did this change?" unanswerable
   * after the first keystroke.
   */
  draft?: string
  bytes?: number
  /**
   * sha256 of the bytes `content` was read from — the `expectedHash` for the
   * next write.
   *
   * This is the whole safety mechanism: `/fs/write` is conditional *always*, so
   * a tab that lost its hash could not save at all without re-reading, and
   * re-reading to save is precisely the race the conditional write exists to
   * prevent.
   */
  hash?: string
  modifiedAt?: number
  /** Why the read failed, verbatim from the gateway. */
  error?: string
  /** A write is in flight. */
  saving?: boolean
  /** Why the last write failed, verbatim from the gateway. */
  saveError?: string
  /**
   * The file changed on disk since this tab read it — the gateway answered 409.
   *
   * Held as a distinct flag rather than folded into `saveError` because it is
   * the one failure with a *choice* attached (reload, overwrite, keep editing)
   * rather than a message to read.
   */
  conflict?: boolean
}

/** Whether a tab has edits that are not on disk. Derived, so typing something
 * and undoing it back leaves the tab clean — which is what an editor should do
 * and what a boolean flag set on first keystroke would get wrong. */
export const isDirty = (file: OpenFile): boolean => file.draft !== undefined && file.draft !== file.content

/** What a tab would write: its edits if it has any, else what it read. */
export const currentText = (file: OpenFile): string => file.draft ?? file.content ?? ''

export type OpenFilesState = {
  /** Tab order, left to right. */
  files: OpenFile[]
  /** Absolute path of the focused tab, or undefined when nothing is open. */
  activePath?: string
}

export type OpenFilesAction =
  | { type: 'open'; path: string }
  | { type: 'close'; path: string }
  | { type: 'closeAll' }
  | { type: 'activate'; path: string }
  /** A read landed. Ignored if the tab was closed while it was in flight. */
  | {
      type: 'loaded'
      path: string
      content: string
      encoding: 'utf8' | 'base64'
      bytes: number
      hash: string
      modifiedAt: number
    }
  | { type: 'failed'; path: string; error: string }
  /** The user typed. */
  | { type: 'edit'; path: string; content: string }
  /** Throw away unsaved edits and go back to what was read. */
  | { type: 'revert'; path: string }
  | { type: 'saveStart'; path: string }
  /** A write succeeded. `content` is **what was written**, not what the tab
   * holds now — the user may have kept typing while it was in flight. */
  | { type: 'saved'; path: string; content: string; bytes: number; hash: string; modifiedAt: number }
  | { type: 'saveFailed'; path: string; error: string; conflict?: boolean }
  /** Dismiss the conflict banner and carry on editing. */
  | { type: 'dismissConflict'; path: string }

export const initialOpenFilesState: OpenFilesState = { files: [] }

/**
 * The tab strip and the editor's whole behaviour, as a pure function.
 *
 * The rules worth stating, because they are the ones a naive implementation
 * gets wrong:
 *
 * - **Opening an open path never re-reads it.** It focuses the tab. Re-reading
 *   would silently discard that tab's unsaved edits on a double click.
 * - **Closing the focused tab focuses its right-hand neighbour**, falling back
 *   to the left when it was last. Focusing "the first tab" instead is what makes
 *   closing several tabs in a row jump the user around.
 * - **A successful save is applied against the text that was sent**, not against
 *   the tab's current text. Typing during a save is normal; treating the write's
 *   completion as "the tab is now clean" would silently drop those keystrokes.
 * - **Nothing here discards edits implicitly.** `revert` and `loaded` are the
 *   only two things that clear a draft, and both are the direct result of
 *   someone asking for it. The conditional write exists so a browser edit cannot
 *   clobber the agent mid-run; this holds the same line in the other direction.
 *
 * Late results are addressed by path and dropped if that tab is gone, so a slow
 * read of a closed file cannot resurrect it.
 */
export const openFilesReducer = (state: OpenFilesState, action: OpenFilesAction): OpenFilesState => {
  switch (action.type) {
    case 'open': {
      if (state.files.some((f) => f.path === action.path)) {
        return state.activePath === action.path ? state : { ...state, activePath: action.path }
      }
      const file: OpenFile = { path: action.path, name: baseName(action.path), status: 'loading' }
      return { files: [...state.files, file], activePath: action.path }
    }

    case 'close': {
      const index = state.files.findIndex((f) => f.path === action.path)
      if (index === -1) {
        return state
      }
      const files = state.files.filter((f) => f.path !== action.path)
      if (state.activePath !== action.path) {
        return { ...state, files }
      }
      // The neighbour that was to the right has slid into this index; if the
      // closed tab was last, take the one now at the end.
      const next = files[index] ?? files[index - 1]
      return { files, activePath: next?.path }
    }

    case 'closeAll':
      return initialOpenFilesState

    case 'activate':
      if (!state.files.some((f) => f.path === action.path)) {
        return state
      }
      return state.activePath === action.path ? state : { ...state, activePath: action.path }

    case 'loaded':
      // Also the "reload from disk" path: the draft goes, deliberately, because
      // the only way here with a dirty tab is someone choosing to discard.
      return patch(state, action.path, () => ({
        path: action.path,
        name: baseName(action.path),
        // A base64 answer means the bytes are not text. The viewer says so
        // rather than rendering the base64, which is the one thing nobody wants
        // to look at — and an editor must never open it, because saving it back
        // as utf8 would corrupt the file.
        status: action.encoding === 'utf8' ? 'ready' : 'binary',
        content: action.encoding === 'utf8' ? action.content : undefined,
        bytes: action.bytes,
        hash: action.hash,
        modifiedAt: action.modifiedAt,
      }))

    case 'failed':
      return patch(state, action.path, (file) => ({ ...file, status: 'error', error: action.error }))

    case 'edit':
      // Only a readable text file can be edited; a binary or errored tab has no
      // content the editor could have been showing.
      return patch(state, action.path, (file) => (file.status === 'ready' ? { ...file, draft: action.content } : file))

    case 'revert':
      return patch(state, action.path, (file) => ({
        ...file,
        draft: undefined,
        saveError: undefined,
        conflict: false,
      }))

    case 'saveStart':
      return patch(state, action.path, (file) => ({
        ...file,
        saving: true,
        saveError: undefined,
        conflict: false,
      }))

    case 'saved':
      return patch(state, action.path, (file) => ({
        ...file,
        saving: false,
        saveError: undefined,
        conflict: false,
        content: action.content,
        bytes: action.bytes,
        hash: action.hash,
        modifiedAt: action.modifiedAt,
        // Keystrokes that landed mid-flight survive; a draft equal to what was
        // written is simply no longer a draft.
        draft: file.draft === action.content ? undefined : file.draft,
      }))

    case 'saveFailed':
      return patch(state, action.path, (file) => ({
        ...file,
        saving: false,
        saveError: action.error,
        conflict: action.conflict ?? false,
      }))

    case 'dismissConflict':
      return patch(state, action.path, (file) => ({
        ...file,
        conflict: false,
        saveError: undefined,
      }))
  }
}

/** Replace one file in place, preserving tab order; a no-op if it was closed
 * while the request was in flight. */
const patch = (state: OpenFilesState, path: string, next: (file: OpenFile) => OpenFile): OpenFilesState => {
  const index = state.files.findIndex((f) => f.path === path)
  if (index === -1) {
    return state
  }
  const current = state.files[index]!
  const updated = next(current)
  if (updated === current) {
    return state
  }
  const files = state.files.slice()
  files[index] = updated
  return { ...state, files }
}

/** Last path segment. Trailing slashes are not expected here — these are file
 * paths from `/fs/list` and `/fs/find` — but a bare `/` should still show as
 * something rather than as an empty tab. */
const baseName = (path: string): string => {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || path
}
