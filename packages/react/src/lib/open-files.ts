export type OpenFile = {
  path: string
  name: string
  status: 'loading' | 'ready' | 'binary' | 'error'
  content?: string
  draft?: string
  bytes?: number
  hash?: string
  modifiedAt?: number
  error?: string
  saving?: boolean
  saveError?: string
  conflict?: boolean
}

export function isDirty(file: OpenFile): boolean {
  return file.draft !== undefined && file.draft !== file.content
}

export function currentText(file: OpenFile): string {
  return file.draft ?? file.content ?? ''
}

export type OpenFilesState = {
  files: OpenFile[]
  activePath?: string
}

export type OpenFilesAction =
  | { type: 'open'; path: string }
  | { type: 'close'; path: string }
  | { type: 'closeAll' }
  | { type: 'activate'; path: string }
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
  | { type: 'edit'; path: string; content: string }
  | { type: 'revert'; path: string }
  | { type: 'saveStart'; path: string }
  | { type: 'saved'; path: string; content: string; bytes: number; hash: string; modifiedAt: number }
  | { type: 'saveFailed'; path: string; error: string; conflict?: boolean }
  | { type: 'dismissConflict'; path: string }

export const initialOpenFilesState: OpenFilesState = { files: [] }

export function openFilesReducer(state: OpenFilesState, action: OpenFilesAction): OpenFilesState {
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
      // The right-hand neighbour has slid into this index; a closed last tab has nothing there.
      const next = files[index] ?? files[index - 1]
      return { files, activePath: next?.path }
    }

    case 'closeAll': {
      return initialOpenFilesState
    }

    case 'activate': {
      if (!state.files.some((f) => f.path === action.path)) {
        return state
      }
      return state.activePath === action.path ? state : { ...state, activePath: action.path }
    }

    case 'loaded': {
      return patch(state, action.path, () => ({
        path: action.path,
        name: baseName(action.path),
        status: action.encoding === 'utf8' ? 'ready' : 'binary',
        content: action.encoding === 'utf8' ? action.content : undefined,
        bytes: action.bytes,
        hash: action.hash,
        modifiedAt: action.modifiedAt,
      }))
    }

    case 'failed': {
      return patch(state, action.path, (file) => ({ ...file, status: 'error', error: action.error }))
    }

    case 'edit': {
      return patch(state, action.path, (file) => (file.status === 'ready' ? { ...file, draft: action.content } : file))
    }

    case 'revert': {
      return patch(state, action.path, (file) => ({
        ...file,
        draft: undefined,
        saveError: undefined,
        conflict: false,
      }))
    }

    case 'saveStart': {
      return patch(state, action.path, (file) => ({
        ...file,
        saving: true,
        saveError: undefined,
        conflict: false,
      }))
    }

    case 'saved': {
      return patch(state, action.path, (file) => ({
        ...file,
        saving: false,
        saveError: undefined,
        conflict: false,
        content: action.content,
        bytes: action.bytes,
        hash: action.hash,
        modifiedAt: action.modifiedAt,
        draft: file.draft === action.content ? undefined : file.draft,
      }))
    }

    case 'saveFailed': {
      return patch(state, action.path, (file) => ({
        ...file,
        saving: false,
        saveError: action.error,
        conflict: action.conflict ?? false,
      }))
    }

    case 'dismissConflict': {
      return patch(state, action.path, (file) => ({
        ...file,
        conflict: false,
        saveError: undefined,
      }))
    }
  }
}

function patch(state: OpenFilesState, path: string, next: (file: OpenFile) => OpenFile): OpenFilesState {
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

function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || path
}
