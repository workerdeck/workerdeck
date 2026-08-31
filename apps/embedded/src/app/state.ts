export type UiState = {
  openDocId?: string
}

export type UiIntent =
  | { type: 'open_doc'; docId: string }
  // Sent whether or not it was the document on screen: every tab's list is now wrong.
  | { type: 'doc_deleted'; docId: string }

export type AppState = {
  get(userId: string): UiState
  set(userId: string, state: UiState): void
  // Returns how many tabs were listening, so a tool can answer "you have no window open" rather than claim it navigated.
  dispatch(userId: string, intent: UiIntent): number
  subscribe(userId: string, listener: (intent: UiIntent) => void): () => void
}

export function createAppState(): AppState {
  const states = new Map<string, UiState>()
  const listeners = new Map<string, Set<(intent: UiIntent) => void>>()

  return {
    get: (userId) => states.get(userId) ?? {},
    set: (userId, state) => {
      states.set(userId, state)
    },
    dispatch: (userId, intent) => {
      const set = listeners.get(userId)
      if (!set || set.size === 0) {
        return 0
      }
      for (const listener of set) {
        listener(intent)
      }
      return set.size
    },
    subscribe: (userId, listener) => {
      let set = listeners.get(userId)
      if (!set) {
        set = new Set()
        listeners.set(userId, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) {
          listeners.delete(userId)
        }
      }
    },
  }
}
