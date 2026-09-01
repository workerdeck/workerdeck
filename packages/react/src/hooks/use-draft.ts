import { useCallback, useMemo } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { draftKey, readDraft, writeDraft } from '../lib/draft-store.ts'

export type UseDraftResult = {
  /** What was left unsent last time, read once so it can seed the composer on mount. */
  initialText: string
  save: (text: string) => void
  clear: () => void
}

/**
 * Remember unsent composer text for a session. Purely local: it never reaches the gateway and never syncs between
 * clients, because a half-written prompt is not something anyone asked to publish.
 */
export function useDraft(client: WorkerDeckClient, sessionId: string | undefined): UseDraftResult {
  const key = sessionId ? draftKey(client, sessionId) : undefined
  // Read once per key: re-reading on render would fight whatever is being typed.
  const initialText = useMemo(() => (key ? readDraft(key) : ''), [key])
  const save = useCallback(
    (text: string) => {
      if (key) {
        writeDraft(key, text)
      }
    },
    [key],
  )
  const clear = useCallback(() => {
    if (key) {
      writeDraft(key, '')
    }
  }, [key])
  return { initialText, save, clear }
}
