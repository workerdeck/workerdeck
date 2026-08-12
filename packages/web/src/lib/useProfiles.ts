import { useCallback, useEffect, useState } from 'react'
import type { ListProfilesResponse, ProfileInfo } from '@workerdeck/protocol'
import { client } from './client.ts'

// Profiles change rarely (server config, plus whatever the Profiles view creates)
// — fetch once per page load and share the result across every consumer, with an
// explicit refresh for the views that mutate them.
const EMPTY: ListProfilesResponse = { profiles: [] }
let cache: ListProfilesResponse | undefined
let inflight: Promise<ListProfilesResponse> | undefined
const subscribers = new Set<(value: ListProfilesResponse) => void>()

async function load(): Promise<ListProfilesResponse> {
  // No gateway yet (the same-origin probe is still out, or a standalone build
  // with none configured) — answer empty rather than throw, and let the caller
  // refresh when one appears.
  const loaded = await (client()?.listProfiles().catch(() => EMPTY) ?? Promise.resolve(EMPTY))
  cache = loaded
  for (const notify of subscribers) notify(loaded)
  return loaded
}

/** The profiles this server declares (filtered server-side to what the caller may
 * use), plus whether this caller may create more. Empty until loaded. */
export function useProfileList(): ListProfilesResponse & { refresh: () => Promise<void> } {
  const [value, setValue] = useState<ListProfilesResponse>(cache ?? EMPTY)

  useEffect(() => {
    subscribers.add(setValue)
    if (!cache) void (inflight ??= load())
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
export function useProfiles(): ProfileInfo[] {
  return useProfileList().profiles
}

const CHOICE_KEY = 'workerdeck.last-profile'

/** Profiles plus a persisted selection for the create forms. `profile` is always a
 * declared name (stored choice when still valid, else the first) — '' while none.
 * `selected` is that profile's record, which the forms read the engine off. */
export function useProfileChoice() {
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
