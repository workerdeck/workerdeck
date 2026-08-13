/**
 * What the user is looking at, and how the agent asks to move them.
 *
 * The problem this solves: the agent loop runs on the server, but "which
 * document is open" is browser state, and "open that one for me" is a browser
 * action. Something has to carry both across.
 *
 * The choice made here is that **the app owns its UI state on the server** — the
 * tab pushes it up on change, and subscribes to intents coming down. The
 * alternative was to bridge the tools into the tab over WorkerDeck's own tool
 * bridge, which is a real mechanism and the natural-looking one. It is rejected
 * for two reasons: a bridged tool is by definition `sandboxed`, and the bridge
 * asks *the first attached client*, so with two tabs open the answer comes from
 * an arbitrary one. Keeping the state here means every tab of a user agrees, and
 * an agent working while the tab is closed still knows where it left them.
 *
 * Keyed by **user**, not by session: two agent sessions in the sidebar are
 * looking at the same screen, and the phrase "the document I'm on" means the
 * same thing to both.
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
      if (!set || set.size === 0) return 0
      for (const listener of set) listener(intent)
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
        if (set.size === 0) listeners.delete(userId)
      }
    },
  }
}
