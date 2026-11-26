import { useSyncExternalStore } from 'react'

// A phone held upright: the camera route of a pairing link lands here, so the dashboard shows one pane at a time.
const QUERY = '(max-width: 767px)'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
