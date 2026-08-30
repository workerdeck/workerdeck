import { useCallback, useEffect, useState } from 'react'
import type { ListProfilesResponse, ProfileInfo } from '@workerdeck/protocol'
import { client } from '../lib/client.ts'

// Profiles change rarely, so: one fetch per page load shared across every consumer, with an
// explicit refresh for the views that mutate them.
const EMPTY: ListProfilesResponse = { profiles: [] }
let cache: ListProfilesResponse | undefined
let inflight: Promise<ListProfilesResponse> | undefined
const subscribers = new Set<(value: ListProfilesResponse) => void>()

const load = async (): Promise<ListProfilesResponse> => {
  // No gateway yet (probe still out, or none configured): answer empty rather than throw.
  const loaded = await (client()
    ?.listProfiles()
    .catch(() => EMPTY) ?? Promise.resolve(EMPTY))
  cache = loaded
  for (const notify of subscribers) {
    notify(loaded)
  }
  return loaded
}

/** The profiles this server declares (filtered server-side to what the caller may
 * use), plus whether this caller may create more. Empty until loaded. */
export const useProfileList = (): ListProfilesResponse & { refresh: () => Promise<void> } => {
  const [value, setValue] = useState<ListProfilesResponse>(cache ?? EMPTY)

  useEffect(() => {
    subscribers.add(setValue)
    if (!cache) {
      void (inflight ??= load())
    }
    return () => {
      subscribers.delete(setValue)
    }
  }, [])

  const refresh = useCallback(async () => {
    inflight = load()
    await inflight
  }, [])

  return { ...value, refresh }
}

/** Just the list, for consumers that don't manage profiles. */
export const useProfiles = (): ProfileInfo[] => useProfileList().profiles

const CHOICE_KEY = 'workerdeck.last-profile'

/** Profiles plus a persisted selection for the create forms. `profile` is always a
 * declared name (stored choice when still valid, else the first) — '' while none.
 * `selected` is that profile's record, which the forms read the engine off. */
export const useProfileChoice = () => {
  const profiles = useProfiles()
  const [choice, setChoice] = useState(() => localStorage.getItem(CHOICE_KEY) ?? '')
  const profile = profiles.some((p) => p.name === choice) ? choice : (profiles[0]?.name ?? '')
  const selected = profiles.find((p) => p.name === profile)
  const select = (name: string) => {
    setChoice(name)
    localStorage.setItem(CHOICE_KEY, name)
  }
  return { profiles, profile, selected, select }
}
