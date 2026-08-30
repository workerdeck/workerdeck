/**
 * What the user is looking at, and how the agent asks to move them: **the app owns
 * its UI state on the server**, not on WorkerDeck's tool bridge (a bridged tool is
 * by definition `sandboxed`, and the bridge asks an arbitrary attached client).
 *
 * Keyed by **user**, not by session: two sessions in the sidebar are looking at the
 * same screen.
 */

export type UiState = {
  /** The document the user currently has open, if any. */
  openDocId?: string
}

/** What the agent asks the app to do. */
export type UiIntent =
  | { type: 'open_doc'; docId: string }
  /** The document is gone. Sent whether or not it was the one on screen: every
   * tab's list is now wrong, not just the one looking at it. */
  | { type: 'doc_deleted'; docId: string }

export type AppState = {
  get(userId: string): UiState
  set(userId: string, state: UiState): void
  /** Ask this user's open tabs to do something. Returns how many were listening
   * — which is what lets a tool answer "you have no window open" honestly
   * instead of claiming it navigated. */
  dispatch(userId: string, intent: UiIntent): number
  /** Subscribe a tab. Returns the unsubscribe. */
  subscribe(userId: string, listener: (intent: UiIntent) => void): () => void
}

export const createAppState = (): AppState => {
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
